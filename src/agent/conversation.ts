/**
 * Conversational (voice) mode of the agent: one spoken turn in, one short spoken reply out, with history.
 *
 * It reuses the shop-mode tools and the gate unchanged (build_cart → Supplier.quote, propose_checkout → placeWithGate)
 * and keeps per-session state across turns: the place, the variants already shown, the quotes already built and the
 * cart that is waiting for a yes. It differs from runShopRequest in four ways:
 *
 *   - history: earlier turns are sent back to the model (capped, see ConversationState.turns),
 *   - the VOICE system prompt (prompts.ts buildVoiceSystemPrompt): short replies in the user's language mix,
 *   - the reply text is streamed (`hooks.onText`) so speech starts before generation ends; `hooks.signal` aborts the
 *     model call on barge-in, but a running tool call is never aborted (it finishes and is recorded),
 *   - one extra tool, `confirm_pending_order`. The model only asks; the rules of docs/VOICE_PROTOCOL.md "Voice approvals"
 *     are enforced here, in code: owner, authenticated connection, the previous turn asked about this exact quote hash,
 *     total ≤ the voice limit (exact paise), and under 90 s since the question. Otherwise it refuses or asks for Face ID.
 *     Approving goes through the injected `approve` (the /approve path: Approval → placeWithGate), nothing new on the
 *     money path. A BLOCK is never pending, so it can never be confirmed.
 *
 * Nothing here auto-proposes a cart the model built but did not propose: in a conversation that cart may be a draft.
 */
import { BazaarError } from '../core/errors.js';
import { formatINR } from '../core/money.js';
import { SanitiseLog, sanitiseField } from '../core/sanitise.js';
import type {
  Household,
  Member,
  Paise,
  PolicyDecision,
  PlacedOrder,
  Quote,
  ShopRequest,
  Supplier,
  SupplierId,
} from '../core/types.js';
import { getServiceable } from '../places/serviceability.js';
import { resolvePlace, type PlaceResolution } from '../places/resolver.js';
import { effectiveProfile } from '../profile/effective.js';
import { normalise } from '../profile/normaliser.js';
import {
  modelFromEnv,
  type AssistantBlock,
  type LlmMessage,
  type LlmResponse,
  type ToolResultBlock,
  type ToolSpec,
} from './llm.js';
import { MAX_TOOL_CALLS, MAX_WALL_MS, makeRequest, type AgentDeps } from './loop.js';
import { buildVoiceSystemPrompt, summarisePolicy } from './prompts.js';
import {
  TOOL_SPECS,
  errorOf,
  executeTool,
  isReadOnlyTool,
  newRunState,
  quoteView,
  type RunState,
  type ToolEnv,
  type ToolResult,
} from './tools.js';
import { scrub, sensitiveStrings, type TokenUsage, type ToolCallTrace, type VoiceOutcome } from './trace.js';

export const VOICE_CONFIRM_WINDOW_MS = 90_000;
export const VOICE_MAX_TURNS = 20;
const MAX_TOKENS = 4096;

/** The held cart the previous turn asked about. Set by code from the gate's answer, never by the model. */
export interface PendingConfirmation {
  quoteHash: string;
  total: Paise;
  supplierId: SupplierId;
  placeId: string;
  reasons: PolicyDecision['reasons'];
  /** Clock ms when the question was asked (end of the turn that asked it). */
  askedAt: number;
  /** Above the voice limit: only Face ID (`approve` from the app) can approve it. */
  needsBiometric: boolean;
  etaMinutes?: number;
}

/** Per-place agent state that lives across turns. */
export interface VoiceAgentContext {
  placeId: string;
  resolution: PlaceResolution;
  suppliers: Supplier[];
  state: RunState;
  sanitiseLog: SanitiseLog;
  /** The supplier carts as found when the session started shopping here (told to the model once). */
  existingSummary: string;
  introduced: boolean;
}

/** What a voice session must provide; src/voice/session.ts implements it. */
export interface ConversationState {
  readonly id: string;
  readonly householdId: string;
  readonly memberId: string;
  /** True only while attached to a connection authenticated with this member's own token. */
  authenticated: boolean;
  /** Completed turns, oldest first; each starts with the user's message. Trimmed to `maxTurns`. */
  turns: LlmMessage[][];
  placeId?: string;
  pending?: PendingConfirmation;
  agent?: VoiceAgentContext;
}

/** What an approval returns (the /approve path, src/api/routes/approve.ts approveQuote). */
export interface ApprovalOutcome {
  decision: PolicyDecision;
  placed: boolean;
  order?: PlacedOrder;
  alreadyPlaced?: boolean;
  requote: boolean;
}

export interface ConversationDeps extends AgentDeps {
  /** Create an owner approval for the hash and re-run the gate (approveQuote). */
  approve(quoteHash: string, who: { householdId: string; memberId: string }): Promise<ApprovalOutcome>;
  /** VOICE_APPROVAL_MAX in paise. */
  voiceApprovalMaxPaise: Paise;
  confirmWindowMs?: number;
  /** Wall clock in ms for the confirmation window (Date.now). */
  clock?: () => number;
  maxTurns?: number;
}

export interface VoiceCart {
  quote: {
    hash: string;
    supplier: SupplierId;
    place: string;
    lines: { name: string; label: string; qty: number; lineTotal: Paise }[];
    fees: { label: string; amount: Paise }[];
    total: Paise;
    etaMinutes?: number;
  };
  removed: { name: string; qty: number }[];
}

export interface VoiceDecision {
  verdict: PolicyDecision['verdict'];
  reasons: PolicyDecision['reasons'];
  quoteHash: string;
  needsBiometric: boolean;
  spokenConfirmation: boolean;
}

export interface VoiceOrder {
  supplierOrderId: string;
  status: string;
  etaMinutes?: number;
}

export interface TurnHooks {
  /** Aborts the in-flight model call (barge-in). Running tool calls always finish. */
  signal?: AbortSignal;
  /** Every text delta of the model's reply, as generated. */
  onText?(delta: string): void;
  onToolStart?(name: string): void;
  onToolEnd?(name: string, ms: number, ok: boolean): void;
  onCart?(cart: VoiceCart): void;
  onDecision?(decision: VoiceDecision): void;
  onOrder?(order: VoiceOrder): void;
}

export interface TurnResult {
  /** The full reply text (model text, or the code-written reply when `byCode`). */
  text: string;
  /** True when `text` was written by code and was NOT streamed through onText: the caller must speak it. */
  byCode: boolean;
  outcome: VoiceOutcome;
  aborted: boolean;
  toolCalls: ToolCallTrace[];
  llmFirstTokenMs?: number;
  usage?: TokenUsage;
  model: string;
  placeId?: string;
}

// ---------- fixed phrases (code-written replies) ----------

type Phrase = 'failed' | 'noStore' | 'placed' | 'cancelled';
const PHRASES: Record<Phrase, Record<string, string>> = {
  failed: {
    'bn-IN': 'দুঃখিত, এখন কার্টটা বানাতে পারলাম না। কিছু অর্ডার হয়নি।',
    'hi-IN': 'माफ़ कीजिए, अभी कार्ट नहीं बन पाया। कुछ भी ऑर्डर नहीं हुआ।',
    'en-IN': "Sorry, I couldn't finish that. Nothing was ordered.",
  },
  noStore: {
    'bn-IN': 'এই জায়গায় এখন কোনো দোকান ডেলিভারি দিচ্ছে না। কিছু অর্ডার হয়নি।',
    'hi-IN': 'इस जगह अभी कोई स्टोर डिलीवरी नहीं कर रहा। कुछ भी ऑर्डर नहीं हुआ।',
    'en-IN': 'No store delivers there right now. Nothing was ordered.',
  },
  placed: {
    'bn-IN': 'অর্ডার হয়ে গেছে।',
    'hi-IN': 'ऑर्डर हो गया।',
    'en-IN': 'Order placed.',
  },
  cancelled: {
    'bn-IN': 'ঠিক আছে, অর্ডার করছি না।',
    'hi-IN': 'ठीक है, ऑर्डर नहीं कर रहे।',
    'en-IN': 'Okay, not ordering it.',
  },
};

export function phrase(p: Phrase, lang: string): string {
  return PHRASES[p][lang] ?? PHRASES[p]['en-IN']!;
}

// ---------- confirm_pending_order ----------

export const CONFIRM_TOOL: ToolSpec = {
  name: 'confirm_pending_order',
  description:
    'Approve and place the held cart that your PREVIOUS turn asked the user to confirm, after the user clearly said yes ("yes", "haan", "hyan, order it"). Pass the quoteHash from propose_checkout. The server checks who is speaking, the amount limit and the time window, and may refuse or require Face ID; follow its `say` hint. Never call it for anything else.',
  input_schema: {
    type: 'object',
    properties: {
      quoteHash: { type: 'string', description: 'The quoteHash of the held cart (from propose_checkout).' },
    },
    required: ['quoteHash'],
  },
};

export const VOICE_TOOL_SPECS: ToolSpec[] = [...TOOL_SPECS.filter((t) => t.name !== 'ask_user'), CONFIRM_TOOL];

export type RefusalReason =
  'owner_required' | 'unauthenticated' | 'nothing_pending' | 'wrong_quote' | 'too_late' | 'needs_biometric';

export interface ConfirmCheck {
  ok: boolean;
  reason?: RefusalReason;
}

/**
 * The "Voice approvals" rules, in one place. `pending` is what the previous turn asked about (or undefined).
 * A spoken yes may approve only when every rule holds.
 */
export function checkVoiceApproval(args: {
  member: Pick<Member, 'role'>;
  authenticated: boolean;
  pending: PendingConfirmation | undefined;
  quoteHash: string;
  now: number;
  maxPaise: Paise;
  windowMs: number;
}): ConfirmCheck {
  const { member, authenticated, pending, quoteHash, now, maxPaise, windowMs } = args;
  if (member.role !== 'owner') return { ok: false, reason: 'owner_required' };
  if (!authenticated) return { ok: false, reason: 'unauthenticated' };
  if (!pending) return { ok: false, reason: 'nothing_pending' };
  if (pending.quoteHash !== quoteHash) return { ok: false, reason: 'wrong_quote' };
  if (!(now - pending.askedAt < windowMs)) return { ok: false, reason: 'too_late' };
  if (pending.needsBiometric || pending.total > maxPaise) return { ok: false, reason: 'needs_biometric' };
  return { ok: true };
}

const REFUSAL_SAY: Record<RefusalReason, string> = {
  owner_required: 'Only an owner can approve payment. Tell the user an owner will approve it; nothing was ordered.',
  unauthenticated: 'This connection cannot approve payment. Nothing was ordered.',
  nothing_pending:
    'There is no held cart waiting for a yes. If they want to order, build the cart and call propose_checkout.',
  wrong_quote:
    'That is not the cart you asked about. Nothing was ordered; say the total of the current cart again and ask.',
  too_late:
    'The confirmation came too late (over 90 seconds). Say the total again and ask again whether to place the order.',
  needs_biometric: 'This total is above the voice limit. Ask them to approve with Face ID on the phone.',
};

// ---------- helpers ----------

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function textOf(blocks: AssistantBlock[]): string {
  return blocks
    .filter((b): b is Extract<AssistantBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
}

function hintsFor(text: string, household: Household, placeId: string): string {
  const place = household.places.find((p) => p.id === placeId)!;
  const n = normalise(text, effectiveProfile(household.profile, place));
  const out: string[] = [];
  for (const i of n.items) {
    const q = i.quantity ? ` x ${i.quantity.amount}${i.quantity.unit ? ` ${i.quantity.unit}` : ''}` : '';
    out.push(`- item: ${i.key} (from "${i.matched}")${q}`);
  }
  for (const r of n.recipes) {
    out.push(`- recipe: ${r.name} for ${r.people}: ${r.lines.map((l) => `${l.key} x${l.quantity}`).join(', ')}`);
  }
  return out.join('\n');
}

export function voiceCart(
  quote: Quote,
  existing: Quote | undefined,
  env: Pick<ToolEnv, 'sanitiseLog' | 'place'>,
): VoiceCart {
  const v = quoteView(quote, env);
  const keep = new Map<string, number>();
  for (const l of quote.lines) keep.set(l.variantId, (keep.get(l.variantId) ?? 0) + l.quantity);
  const removed: VoiceCart['removed'] = [];
  for (const l of existing?.lines ?? []) {
    const gone = l.quantity - (keep.get(l.variantId) ?? 0);
    if (gone > 0) {
      removed.push({
        name: sanitiseField(l.name, `${quote.supplierId}:cart:${l.variantId}.name`, env.sanitiseLog, '(name withheld)'),
        qty: gone,
      });
    }
  }
  return {
    quote: {
      hash: v.quoteHash,
      supplier: v.supplier,
      place: v.place,
      lines: v.lines.map((l) => ({ name: l.name, label: l.label, qty: l.quantity, lineTotal: l.lineTotal })),
      fees: v.fees.map((f) => ({ label: f.label, amount: f.amount })),
      total: v.total,
      ...(v.etaMinutes !== undefined ? { etaMinutes: v.etaMinutes } : {}),
    },
    removed,
  };
}

function trimTurns(turns: LlmMessage[][], max: number): void {
  if (turns.length > max) turns.splice(0, turns.length - max);
}

/** Make the turn end on an assistant message so the next turn's user message alternates correctly. */
function closeTurn(msgs: LlmMessage[], text: string): void {
  const last = msgs[msgs.length - 1];
  if (last?.role === 'assistant') return;
  msgs.push({ role: 'assistant', content: [{ type: 'text', text: text.trim() || '(no reply)' }] });
}

/** Set up (or reuse) the per-place agent context: serviceable suppliers and the carts as found. */
async function agentContext(
  session: ConversationState,
  household: Household,
  resolution: PlaceResolution,
  deps: ConversationDeps,
  nowIso: string,
): Promise<VoiceAgentContext> {
  const placeId = session.placeId!;
  if (session.agent && session.agent.placeId === placeId) return session.agent;
  const place = household.places.find((p) => p.id === placeId)!;
  const sanitiseLog = deps.sanitiseLog ?? new SanitiseLog();
  const serviceable = await getServiceable(place, deps.suppliers, nowIso);
  if (serviceable.probed.length > 0) {
    place.serviceability = serviceable.records;
    await deps.store.saveServiceability(place.id, serviceable.records);
  }
  const state = newRunState();
  const lines: string[] = [];
  for (const s of serviceable.suppliers) {
    try {
      const cart = await s.readCart(place);
      state.existingCarts.set(s.id, cart);
      for (const l of cart.lines) state.seenVariants.add(l.variantId);
      const view = quoteView(cart, { sanitiseLog, place });
      lines.push(
        view.lines.length === 0
          ? `- ${s.id}: empty`
          : `- ${s.id}: ${view.lines.map((l) => `${l.quantity} x ${l.name} ${l.label} (variantId ${l.variantId})`).join('; ')}`,
      );
    } catch (e) {
      deps.log?.('read_cart_failed', { supplier: s.id, error: errMessage(e) });
      lines.push(`- ${s.id}: could not be read`);
    }
  }
  session.agent = {
    placeId,
    resolution,
    suppliers: serviceable.suppliers,
    state,
    sanitiseLog,
    existingSummary: lines.join('\n'),
    introduced: false,
  };
  return session.agent;
}

// ---------- the turn ----------

/**
 * Run one spoken turn. `userText` is the final transcript; `lang` is the reply language (bn-IN / hi-IN / en-IN).
 * Never throws for model or tool failures: those end the turn with a short code-written reply ("Nothing was ordered").
 */
export async function runConversationTurn(
  session: ConversationState,
  userText: string,
  lang: string,
  deps: ConversationDeps,
  hooks: TurnHooks = {},
): Promise<TurnResult> {
  const clock = deps.clock ?? Date.now;
  const now = deps.now ?? (() => new Date().toISOString());
  const maxCalls = deps.maxToolCalls ?? MAX_TOOL_CALLS;
  const maxWallMs = deps.maxWallMs ?? MAX_WALL_MS;
  const windowMs = deps.confirmWindowMs ?? VOICE_CONFIRM_WINDOW_MS;
  const model = deps.model ?? modelFromEnv();
  const startedAt = performance.now();
  const toolTrace: ToolCallTrace[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, llmCalls: 0 };
  let usageReported = false;

  // The pending confirmation belongs to the previous turn only: a yes must come in the very next turn.
  const pending = session.pending;
  session.pending = undefined;
  let newPending: Omit<PendingConfirmation, 'askedAt'> | undefined;

  const household = await deps.store.loadHousehold(session.householdId);
  const member = household.members.find((m) => m.id === session.memberId);
  if (!member)
    throw new BazaarError('UNKNOWN_MEMBER', `member ${session.memberId} is not in household ${household.id}`);
  const request: ShopRequest = makeRequest(
    { householdId: household.id, memberId: member.id, text: userText, channel: 'voice' },
    now(),
  );
  await deps.store.saveRequest(request);

  const turnMsgs: LlmMessage[] = [];
  const result = (r: Omit<TurnResult, 'toolCalls' | 'model'>): TurnResult => {
    session.turns.push(turnMsgs);
    trimTurns(session.turns, deps.maxTurns ?? VOICE_MAX_TURNS);
    if (newPending && !r.aborted) session.pending = { ...newPending, askedAt: clock() };
    return { ...r, toolCalls: toolTrace, model, ...(usageReported ? { usage } : {}) };
  };
  const codeReply = (text: string, outcome: VoiceOutcome): TurnResult => {
    if (turnMsgs.length === 0) turnMsgs.push({ role: 'user', content: `${member.name} said: """${userText}"""` });
    closeTurn(turnMsgs, text);
    return result({
      text,
      byCode: true,
      outcome,
      aborted: false,
      ...(session.placeId ? { placeId: session.placeId } : {}),
    });
  };

  // 1. Place: kept across turns; an explicit mention switches it. Code decides, never the model.
  const resolution = resolvePlace(request, household, member);
  if (resolution.question) return codeReply(resolution.question, 'asked');
  const switching = resolution.reason === 'explicit' && resolution.placeId !== session.placeId;
  if (!session.placeId || switching) session.placeId = resolution.placeId;
  const place = household.places.find((p) => p.id === session.placeId);
  if (!place) {
    session.placeId = resolution.placeId;
    return codeReply(phrase('failed', lang), 'failed');
  }

  const agent = await agentContext(session, household, resolution, deps, now());
  if (agent.suppliers.length === 0) return codeReply(phrase('noStore', lang), 'failed');

  // Per-turn view of the shared run state.
  const state = agent.state;
  state.questions = [];
  state.stop = false;
  delete state.decision;
  delete state.order;
  delete state.gateLine;
  delete state.chosen;

  const payment = deps.payment ?? { kind: 'cod' as const };
  const env: ToolEnv = {
    request,
    household,
    member,
    place,
    resolution: agent.resolution,
    suppliers: agent.suppliers,
    store: deps.store,
    now,
    payment,
    sanitiseLog: agent.sanitiseLog,
    state,
  };

  // 2. The user's message for this turn.
  const parts = [`${member.name} (${member.role}) said, in ${lang}: """${userText}"""`];
  if (!agent.introduced || switching) {
    parts.push(
      '',
      `Delivery place: ${place.nickname} (${agent.resolution.reason === 'explicit' || switching ? 'explicit' : resolution.reason}).`,
      'Supplier carts as found when this conversation started shopping here (lines not needed will be replaced):',
      agent.existingSummary,
    );
    agent.introduced = true;
  }
  const hints = hintsFor(userText, household, place.id);
  if (hints) parts.push('', 'Normaliser hints (deterministic; verify):', hints);
  if (pending) {
    parts.push(
      '',
      `Your previous turn asked to confirm the held cart of ${formatINR(pending.total)} (quoteHash ${pending.quoteHash}). If this is a clear yes, call confirm_pending_order with that quoteHash.`,
    );
  }
  turnMsgs.push({ role: 'user', content: parts.join('\n') });

  const system = buildVoiceSystemPrompt(household, place, summarisePolicy(household.policy), {
    requestingMember: member,
    placeReason: agent.resolution.reason,
    now: now(),
    maxToolCalls: maxCalls,
    lang,
    voiceApprovalMax: deps.voiceApprovalMaxPaise,
  });
  const sensitive = sensitiveStrings(household, place);
  const deadline = startedAt + maxWallMs;
  const remaining = () => deadline - performance.now();

  let llmFirstTokenMs: number | undefined;
  let spokeThisCall = false;
  const onText = (delta: string) => {
    if (delta === '') return;
    llmFirstTokenMs ??= Math.round(performance.now() - startedAt);
    spokeThisCall = true;
    hooks.onText?.(delta);
  };

  // confirm_pending_order: the rules are code; the approval and the placement are the /approve path.
  const confirm = async (input: unknown): Promise<ToolResult> => {
    const quoteHash =
      typeof input === 'object' && input !== null && typeof (input as { quoteHash?: unknown }).quoteHash === 'string'
        ? (input as { quoteHash: string }).quoteHash.trim()
        : '';
    const check = checkVoiceApproval({
      member,
      authenticated: session.authenticated,
      pending,
      quoteHash,
      now: clock(),
      maxPaise: deps.voiceApprovalMaxPaise,
      windowMs,
    });
    if (!check.ok) {
      const reason = check.reason!;
      deps.log?.('voice_confirm_refused', { reason });
      if (reason === 'needs_biometric' && pending) {
        // Still waiting: the app runs Face ID and sends `approve` for this hash.
        newPending = { ...pending, needsBiometric: true };
        hooks.onDecision?.({
          verdict: 'HOLD',
          reasons: pending.reasons,
          quoteHash: pending.quoteHash,
          needsBiometric: true,
          spokenConfirmation: false,
        });
        return { ok: false, needsBiometric: true, refused: reason, say: REFUSAL_SAY[reason] };
      }
      if (reason === 'too_late' && pending) {
        // Re-arm: the reply must say the total again and ask; the next yes starts a fresh 90 s.
        newPending = { ...pending };
        return {
          ok: false,
          refused: reason,
          total: pending.total,
          totalInr: formatINR(pending.total),
          say: REFUSAL_SAY[reason],
        };
      }
      return { ok: false, refused: reason, say: REFUSAL_SAY[reason] };
    }
    try {
      const out = await deps.approve(quoteHash, { householdId: household.id, memberId: member.id });
      state.decision = out.decision;
      hooks.onDecision?.({
        verdict: out.decision.verdict,
        reasons: out.decision.reasons,
        quoteHash,
        needsBiometric: false,
        spokenConfirmation: true,
      });
      if (out.order && (out.placed || out.alreadyPlaced)) {
        state.order = out.order;
        hooks.onOrder?.({
          supplierOrderId: out.order.supplierOrderId,
          status: out.order.status,
          ...(pending!.etaMinutes !== undefined ? { etaMinutes: pending!.etaMinutes } : {}),
        });
        return {
          ok: true,
          status: 'PLACED',
          ...(out.alreadyPlaced ? { alreadyPlaced: true } : {}),
          total: pending!.total,
          totalInr: formatINR(pending!.total),
          ...(pending!.etaMinutes !== undefined ? { etaMinutes: pending!.etaMinutes } : {}),
        };
      }
      return {
        ok: true,
        status: out.decision.verdict,
        reasons: out.decision.reasons,
        requote: out.requote,
        say: out.requote
          ? 'The cart changed at the store. Nothing was ordered; rebuild the cart and propose again.'
          : 'The gate did not allow this order. Nothing was ordered; say why in one sentence.',
      };
    } catch (e) {
      const message = sanitiseField(errMessage(e), 'voice.confirm.error', agent.sanitiseLog, 'approval failed');
      return { ok: false, status: 'ERROR', error: message, say: 'Approval failed. Nothing was ordered.' };
    }
  };

  // After propose_checkout: tell the app (cart is sent on build), set what the next turn may confirm.
  const afterPropose = (r: ToolResult): ToolResult => {
    const quote = state.chosen;
    const decision = state.decision;
    if (!quote || !decision) return r;
    const owner = member.role === 'owner';
    const overLimit = quote.total > deps.voiceApprovalMaxPaise;
    if (decision.verdict === 'HOLD') {
      const needsBiometric = owner && overLimit;
      const spokenConfirmation = owner && !overLimit;
      if (owner) {
        newPending = {
          quoteHash: quote.hash,
          total: quote.total,
          supplierId: quote.supplierId,
          placeId: quote.placeId,
          reasons: decision.reasons,
          needsBiometric,
          ...(quote.etaMinutes !== undefined ? { etaMinutes: quote.etaMinutes } : {}),
        };
      }
      hooks.onDecision?.({
        verdict: 'HOLD',
        reasons: decision.reasons,
        quoteHash: quote.hash,
        needsBiometric,
        spokenConfirmation,
      });
      const next = !owner
        ? 'Say the total and that an owner will approve it. Do not ask this member to confirm.'
        : needsBiometric
          ? 'Say the total and ask them to approve with Face ID on the phone.'
          : 'End your reply by saying the total in words and asking whether to place the order.';
      return { ...r, voice: { next, totalInr: formatINR(quote.total) } };
    }
    hooks.onDecision?.({
      verdict: decision.verdict,
      reasons: decision.reasons,
      quoteHash: quote.hash,
      needsBiometric: false,
      spokenConfirmation: false,
    });
    if (decision.verdict === 'PAY' && state.order) {
      hooks.onOrder?.({
        supplierOrderId: state.order.supplierOrderId,
        status: state.order.status,
        ...(quote.etaMinutes !== undefined ? { etaMinutes: quote.etaMinutes } : {}),
      });
      return { ...r, voice: { next: 'Say it is ordered, the total, and the delivery time if known.' } };
    }
    return { ...r, voice: { next: 'Say plainly what was blocked; it cannot be approved by voice or Face ID.' } };
  };

  const runTool = async (use: {
    id: string;
    name: string;
    input: unknown;
  }): Promise<{ result: ToolResult; ms: number }> => {
    hooks.onToolStart?.(use.name);
    const t0 = performance.now();
    let result: ToolResult;
    try {
      result = use.name === CONFIRM_TOOL.name ? await confirm(use.input) : await executeTool(use.name, use.input, env);
      if (use.name === 'build_cart' && result.ok) {
        const supplierId = (result.quote as { supplier?: SupplierId } | undefined)?.supplier;
        const q = supplierId ? state.quotes.get(supplierId) : undefined;
        if (q) hooks.onCart?.(voiceCart(q, state.existingCarts.get(q.supplierId), env));
      }
      if (use.name === 'propose_checkout') result = afterPropose(result);
    } catch (e) {
      result = {
        ok: false,
        error: sanitiseField(errMessage(e), `tool:${use.name}.error`, agent.sanitiseLog, 'tool failed'),
      };
    }
    const ms = Math.round(performance.now() - t0);
    hooks.onToolEnd?.(use.name, ms, result.ok);
    return { result, ms };
  };

  // 3. The tool loop. The model call is abortable (barge-in); tool calls are not.
  const history = session.turns.flat();
  let toolCalls = 0;
  let finalText = '';
  let aborted = false;
  let failed = false;
  const tools = VOICE_TOOL_SPECS;

  for (let turn = 0; turn < maxCalls + 3; turn++) {
    if (hooks.signal?.aborted) {
      aborted = true;
      break;
    }
    if (remaining() <= 0) {
      failed = true;
      break;
    }
    const budgetSpent = toolCalls >= maxCalls;
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(remaining())));
    const signal = hooks.signal ? AbortSignal.any([hooks.signal, timeout]) : timeout;
    const req = {
      model,
      max_tokens: MAX_TOKENS,
      system,
      tools,
      messages: [...history, ...turnMsgs],
      signal,
      ...(budgetSpent ? { tool_choice: { type: 'none' as const } } : {}),
    };
    let response: LlmResponse;
    spokeThisCall = false;
    try {
      if (deps.llm.stream) {
        response = await deps.llm.stream(req, onText);
      } else {
        response = await deps.llm.create(req);
        if (!response.content.some((b) => b.type === 'tool_use')) onText(textOf(response.content));
      }
    } catch (e) {
      if (hooks.signal?.aborted) aborted = true;
      else {
        deps.log?.('llm_failed', scrub(errMessage(e), sensitive));
        failed = true;
      }
      break;
    }
    // Text from separate model calls must not run together into one sentence.
    if (spokeThisCall) hooks.onText?.('\n');
    if (response.usage) {
      usageReported = true;
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
    }
    usage.llmCalls++;
    const content = response.content.filter((b) => b.type !== 'text' || b.text.trim() !== '');
    const uses = content.filter((b): b is Extract<AssistantBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (content.length > 0) turnMsgs.push({ role: 'assistant', content });
    if (uses.length === 0) {
      if (response.stop_reason === 'max_tokens' || content.length === 0) failed = true;
      else finalText = textOf(content);
      break;
    }
    if (budgetSpent) {
      // The model ignored tool_choice: none. Answer its calls so the history stays well-formed.
      turnMsgs.push({
        role: 'user',
        content: uses.map((u) => ({
          type: 'tool_result' as const,
          tool_use_id: u.id,
          is_error: true,
          content: JSON.stringify({ ok: false, error: 'tool budget spent' }),
        })),
      });
      failed = true;
      break;
    }

    const allowed = uses.slice(0, Math.max(0, maxCalls - toolCalls));
    const allowedIds = new Set(allowed.map((u) => u.id));
    toolCalls += allowed.length;
    const done = new Map<string, { result: ToolResult; ms: number }>();
    await Promise.all(allowed.filter((u) => isReadOnlyTool(u.name)).map(async (u) => done.set(u.id, await runTool(u))));
    for (const u of allowed.filter((x) => !isReadOnlyTool(x.name))) done.set(u.id, await runTool(u));

    const results: ToolResultBlock[] = [];
    for (const use of uses) {
      if (!allowedIds.has(use.id)) {
        toolTrace.push({ name: use.name, ms: 0, ok: false, errorKind: 'budget' });
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: JSON.stringify({ ok: false, error: 'tool budget spent; reply now' }),
        });
        continue;
      }
      const { result: r, ms } = done.get(use.id)!;
      const err = errorOf(r);
      toolTrace.push({
        name: use.name,
        ms,
        ok: r.ok,
        ...(err
          ? { errorKind: err.kind, ...(err.message ? { errorMessage: scrub(err.message, sensitive) } : {}) }
          : {}),
      });
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(r),
        ...(r.ok ? {} : { is_error: true }),
      });
    }
    turnMsgs.push({ role: 'user', content: results });
  }

  // 4. Outcome and reply. (Read through a function: the tools mutate `state` behind TypeScript's narrowing.)
  const decided = (): { order?: PlacedOrder; decision?: PolicyDecision } => state;
  const { order, decision } = decided();
  const outcome: VoiceOutcome = aborted
    ? 'interrupted'
    : order
      ? 'paid'
      : decision?.verdict === 'HOLD'
        ? 'held'
        : decision?.verdict === 'BLOCK'
          ? 'blocked'
          : failed
            ? 'failed'
            : toolTrace.some((t) => t.name === 'build_cart' && t.ok)
              ? 'quoted'
              : 'replied';

  if (aborted) {
    closeTurn(turnMsgs, '[interrupted by the user]');
    return result({
      text: '',
      byCode: false,
      outcome,
      aborted: true,
      ...(llmFirstTokenMs !== undefined ? { llmFirstTokenMs } : {}),
      placeId: place.id,
    });
  }
  if (failed || finalText === '') {
    const text = order ? phrase('placed', lang) : phrase('failed', lang);
    closeTurn(turnMsgs, text);
    return result({
      text,
      byCode: true,
      outcome,
      aborted: false,
      ...(llmFirstTokenMs !== undefined ? { llmFirstTokenMs } : {}),
      placeId: place.id,
    });
  }
  return result({
    text: finalText,
    byCode: false,
    outcome,
    aborted: false,
    ...(llmFirstTokenMs !== undefined ? { llmFirstTokenMs } : {}),
    placeId: place.id,
  });
}

/** Record a turn the app drove without speech (Face ID approve, cancel), so the model sees it next time. */
export function noteTurn(session: ConversationState, userNote: string, reply: string): void {
  session.turns.push([
    { role: 'user', content: userNote },
    { role: 'assistant', content: [{ type: 'text', text: reply }] },
  ]);
}
