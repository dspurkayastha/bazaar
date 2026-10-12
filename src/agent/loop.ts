/**
 * runShopRequest: one ShopRequest in, one ShopResult out.
 *
 *   1. resolve the place (code, not the model); a tie ends the request with a question,
 *   2. find the suppliers that serve it (cached 24 h, else probed),
 *   3. read each supplier cart so leftovers can be reconciled and reported,
 *   4. run the Claude tool-use loop (max 12 tool calls),
 *   5. if a cart was built but never proposed, propose it ourselves (the gate always runs),
 *   6. assemble the summary: names the place, reports removals and ignored supplier text, ends with the gate line.
 *
 * Everything external is injected through AgentDeps, so tests run with the stub supplier, the in-memory store and a
 * scripted LLM.
 */
import { SanitiseLog, sanitiseField } from '../core/sanitise.js';
import { newId } from '../core/ids.js';
import type {
  Household,
  ISODateTime,
  Member,
  PaymentMethod,
  Place,
  PolicyContext,
  Quote,
  ShopRequest,
  ShopResult,
  Supplier,
  SupplierId,
} from '../core/types.js';
import { BazaarError } from '../core/errors.js';
import { formatINR } from '../core/money.js';
import { getServiceable } from '../places/serviceability.js';
import { resolvePlace, type PlaceResolution } from '../places/resolver.js';
import { effectiveProfile } from '../profile/effective.js';
import { normalise } from '../profile/normaliser.js';
import {
  modelFromEnv,
  type AssistantBlock,
  type LlmClient,
  type LlmMessage,
  type LlmResponse,
  type ToolResultBlock,
} from './llm.js';
import { buildSystemPrompt, summarisePolicy } from './prompts.js';
import type { Store } from './store.js';
import {
  TOOL_SPECS,
  errorOf,
  executeTool,
  isReadOnlyTool,
  gateLine,
  gateLineNotRun,
  newRunState,
  proposeCheckoutFor,
  quoteView,
  type RunState,
  type ToolEnv,
  type ToolResult,
} from './tools.js';
import {
  scrub,
  sensitiveStrings,
  type Outcome,
  type RequestTelemetry,
  type TokenUsage,
  type ToolCallTrace,
} from './trace.js';

export const MAX_TOOL_CALLS = 20;
/** Wall-clock cap for the whole model/tool loop. */
export const MAX_WALL_MS = 60_000;
/** A 12-item build_cart is a long tool_use block; 1500 tokens could truncate it. */
const MAX_TOKENS = 4096;

export interface AgentDeps {
  store: Store;
  suppliers: Supplier[];
  llm: LlmClient;
  /** Defaults to ANTHROPIC_MODEL, then claude-sonnet-5-5. */
  model?: string;
  maxToolCalls?: number;
  /** Wall-clock cap for the loop (default 60 s). */
  maxWallMs?: number;
  now?: () => ISODateTime;
  /** Household default payment method; v1 is cash on delivery. */
  payment?: PaymentMethod;
  sanitiseLog?: SanitiseLog;
  log?: (event: string, data?: unknown) => void;
}

export interface TraceEntry {
  tool: string;
  input: unknown;
  result: unknown;
}

export interface ShopOutcome {
  result: ShopResult;
  trace: TraceEntry[];
  toolCalls: number;
  sanitiseLog: SanitiseLog;
  /** Safe to log: tool names, timings, error kinds, outcome, token usage. No arguments, tokens or addresses. */
  telemetry: RequestTelemetry;
}

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

/** Deterministic hints from the normaliser, for the model to verify (never to trust blindly). */
function hintsFor(request: ShopRequest, household: Household, place: Place): string {
  const profile = effectiveProfile(household.profile, place);
  const n = normalise(request.text, profile);
  const lines: string[] = [];
  for (const i of n.items) {
    const q = i.quantity ? ` x ${i.quantity.amount}${i.quantity.unit ? ` ${i.quantity.unit}` : ''}` : '';
    lines.push(
      `- item: ${i.key} (from "${i.matched}")${q}${i.packs !== undefined ? ` = ${i.packs} pack(s) of the default size` : ''}`,
    );
  }
  for (const r of n.recipes) {
    lines.push(
      `- recipe: ${r.name} for ${r.people} (${r.peopleSource}): ${r.lines.map((l) => `${l.key} x${l.quantity}${l.optional ? ' (optional)' : ''}`).join(', ')}${r.skippedPantry.length > 0 ? `; pantry, not bought: ${r.skippedPantry.join(', ')}` : ''}`,
    );
  }
  if (n.usual) {
    if (n.usual.lists.length === 0) lines.push('- "the usual": no usual list saved; use go_to_items');
    else if (n.usual.ambiguous)
      lines.push(`- "the usual": several lists (${n.usual.lists.map((l) => l.name).join(', ')}); ask which`);
    else
      for (const l of n.usual.lists)
        lines.push(`- usual list "${l.name}": ${l.items.map((i) => `${i.key} x${i.quantity}`).join(', ')}`);
  }
  return lines.length > 0 ? lines.join('\n') : '- (nothing matched; work from the text)';
}

function userMessage(
  request: ShopRequest,
  member: Member,
  place: Place,
  resolution: PlaceResolution,
  hints: string,
  existing: string,
): string {
  return [
    `Request from ${member.name} (${member.role}) via ${request.channel}:`,
    `"""${request.text}"""`,
    '',
    `Delivery place: ${place.nickname} (${resolution.reason}).`,
    '',
    'Normaliser hints (deterministic; verify against the request):',
    hints,
    '',
    'Existing supplier carts before this request (lines not needed for this request will be removed and reported):',
    existing,
  ].join('\n');
}

function cartLines(q: Quote | undefined): { variantId: string; name: string; quantity: number }[] {
  return (q?.lines ?? []).map((l) => ({ variantId: l.variantId, name: l.name, quantity: l.quantity }));
}

/** Existing lines minus what the final cart keeps. */
function reconcile(
  existing: Map<SupplierId, Quote>,
  final: Map<SupplierId, Quote>,
  log: SanitiseLog,
): { name: string; quantity: number }[] {
  const removed: { name: string; quantity: number }[] = [];
  for (const [supplierId, cart] of existing) {
    const keep = new Map<string, number>();
    for (const l of final.get(supplierId)?.lines ?? []) keep.set(l.variantId, l.quantity);
    for (const l of cartLines(cart)) {
      const gone = l.quantity - (keep.get(l.variantId) ?? 0);
      if (gone > 0)
        removed.push({
          name: sanitiseField(l.name, `${supplierId}:cart:${l.variantId}.name`, log, '(name withheld)'),
          quantity: gone,
        });
    }
  }
  return removed;
}

/** The gate line is generated by code; drop any the model wrote (it is told to end with ours). */
function stripGateLines(text: string): string {
  const i = text.search(/\bGate:/);
  return (i >= 0 ? text.slice(0, i) : text).replace(/\s+/g, ' ').trim();
}

function listRemoved(removed: { name: string; quantity: number }[]): string {
  return removed.map((r) => `${r.quantity} x ${r.name}`).join(', ');
}

// ---------- ending the loop honestly ----------

type AbnormalKind = 'budget' | 'wall_time' | 'repeated_error' | 'llm_error' | 'no_final_text';
interface Abnormal {
  kind: AbnormalKind;
  detail?: string;
}

interface FailureNote {
  kind: string;
  message: string;
  supplier: string;
}

const NARRATION =
  /^(let me(?! know)|let's|now,? (let me|let's|i'?ll|i will|i'm going to|i am going to)|i'?ll|i will|i'm going to|i am going to|next,? (let me|i'?ll|i will)|first,? (let me|i'?ll|i will)|okay,? (let me|let's|now)|good!? (now|let me)|great!? (now|let me))\b/i;

/**
 * The model's final text, minus trailing "let me.../now I will..." narration. `midPlan` means the message is not a
 * final answer at all (nothing left after stripping, or it ends in a colon): the caller treats that as abnormal.
 */
export function cleanFinalText(text: string): { text: string; midPlan: boolean } {
  const flat = stripGateLines(text);
  if (flat === '') return { text: '', midPlan: false };
  const sentences = flat.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g)?.map((x) => x.trim()) ?? [flat];
  let end = sentences.length;
  while (end > 0 && NARRATION.test(sentences[end - 1]!)) end--;
  const kept = sentences.slice(0, end).join(' ').trim();
  const midPlan = kept === '' || /[:,;]$/.test(kept);
  return { text: midPlan ? '' : kept, midPlan };
}

function capitalise(s: string): string {
  return s === '' ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** One line, plain words, on why the cart is missing. */
function failureReason(note: FailureNote): string {
  const who = capitalise(note.supplier);
  const msg = note.message.replace(/\s+/g, ' ').trim().slice(0, 200);
  const detail = msg === '' ? '' : ` (${msg})`;
  switch (note.kind) {
    case 'supplier':
      return /bill|reconcil|parse|unreadable|unexpected/i.test(msg)
        ? `${who} returned a bill I couldn't read${detail}`
        : `${who} failed while I was building the cart${detail}`;
    case 'quote_mismatch':
      return `the ${who} cart changed while I was pricing it${detail}`;
    case 'invalid_line':
      return `${who} would not accept the cart lines${detail}`;
    default:
      return `a ${note.kind} error stopped me${detail}`;
  }
}

function abnormalReason(a: Abnormal, last: FailureNote | undefined, maxCalls: number, maxWallMs: number): string {
  if (last) return failureReason(last);
  switch (a.kind) {
    case 'budget':
      return `I used all ${maxCalls} tool calls without finishing`;
    case 'wall_time':
      return `it took longer than ${Math.round(maxWallMs / 1000)} seconds`;
    case 'llm_error':
      return 'the assistant service did not answer';
    case 'repeated_error':
      return 'the same error kept coming back';
    case 'no_final_text':
      return 'I did not reach a final answer';
  }
}

/** How the request reached us. Absent = the member authenticated with their own token. */
export interface RunOptions {
  /** A signed channel webhook (WhatsApp): see PolicyContext.webhook. */
  webhook?: NonNullable<PolicyContext['webhook']>;
}

export async function runShopRequestDetailed(
  request: ShopRequest,
  deps: AgentDeps,
  opts: RunOptions = {},
): Promise<ShopOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? (() => undefined);
  const sanitiseLog = deps.sanitiseLog ?? new SanitiseLog();
  const maxCalls = deps.maxToolCalls ?? MAX_TOOL_CALLS;
  const maxWallMs = deps.maxWallMs ?? MAX_WALL_MS;
  const payment: PaymentMethod = deps.payment ?? { kind: 'cod' };
  const trace: TraceEntry[] = [];
  const startedAt = performance.now();
  const model = deps.model ?? modelFromEnv();
  const toolTrace: ToolCallTrace[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, llmCalls: 0 };
  let usageReported = false;

  const household = await deps.store.loadHousehold(request.householdId);
  const member = household.members.find((m) => m.id === request.memberId);
  if (!member)
    throw new BazaarError('UNKNOWN_MEMBER', `member ${request.memberId} is not in household ${household.id}`);
  await deps.store.saveRequest(request);

  const finish = async (
    result: ShopResult,
    toolCalls: number,
    outcome: Outcome,
    abnormal?: Abnormal,
  ): Promise<ShopOutcome> => {
    const telemetry: RequestTelemetry = {
      requestId: request.id,
      placeId: result.placeId,
      model,
      toolCalls: toolTrace,
      totalMs: Math.round(performance.now() - startedAt),
      outcome,
      ...(abnormal ? { abnormal: abnormal.kind } : {}),
      ...(usageReported ? { usage } : {}),
    };
    try {
      await deps.store.saveResult(result);
    } catch (e) {
      // The order (if any) is already placed and recorded by the gate; do not turn that into a failure.
      log('save_result_failed', errMessage(e));
    }
    return { result, trace, toolCalls, sanitiseLog, telemetry };
  };

  // 1. Place.
  const resolution = resolvePlace(request, household, member);
  const place = household.places.find((p) => p.id === resolution.placeId)!;

  if (resolution.question) {
    const names = (resolution.candidates ?? []).map((id) => household.places.find((p) => p.id === id)?.nickname ?? id);
    return finish(
      {
        requestId: request.id,
        placeId: place.id,
        placeReason: resolution.reason,
        quotes: [],
        removedFromCart: [],
        questions: [resolution.question],
        summary: `I could not tell which place you meant (${names.join(' or ')}), so I have not touched any cart. ${resolution.question} ${gateLineNotRun('waiting for the place')}`,
      },
      0,
      'asked',
    );
  }

  // 2. Suppliers that serve it.
  const serviceable = await getServiceable(place, deps.suppliers, now());
  if (serviceable.probed.length > 0) {
    place.serviceability = serviceable.records;
    await deps.store.saveServiceability(place.id, serviceable.records);
  }
  if (serviceable.suppliers.length === 0) {
    return finish(
      {
        requestId: request.id,
        placeId: place.id,
        placeReason: resolution.reason,
        quotes: [],
        removedFromCart: [],
        questions: [],
        summary: `No store I can use delivers to ${place.nickname} right now, so nothing was ordered. ${gateLineNotRun('no serviceable store')}`,
      },
      0,
      'failed',
    );
  }

  // 3. Existing carts.
  const state: RunState = newRunState();
  const existingLines: string[] = [];
  for (const s of serviceable.suppliers) {
    try {
      const cart = await s.readCart(place);
      state.existingCarts.set(s.id, cart);
      for (const l of cart.lines) state.seenVariants.add(l.variantId);
      const view = quoteView(cart, { sanitiseLog, place });
      existingLines.push(
        view.lines.length === 0
          ? `- ${s.id}: empty`
          : `- ${s.id}: ${view.lines.map((l) => `${l.quantity} x ${l.name} ${l.label} (variantId ${l.variantId})`).join('; ')}`,
      );
    } catch (e) {
      log('read_cart_failed', { supplier: s.id, error: errMessage(e) });
      existingLines.push(
        `- ${s.id}: could not be read (${sanitiseField(errMessage(e), 'read_cart.error', sanitiseLog)})`,
      );
    }
  }

  const env: ToolEnv = {
    request,
    household,
    member,
    place,
    resolution,
    suppliers: serviceable.suppliers,
    store: deps.store,
    now,
    payment,
    sanitiseLog,
    state,
    ...(opts.webhook ? { webhook: opts.webhook } : {}),
  };

  // 4. The tool-use loop: at most maxCalls tool calls and maxWallMs of wall time.
  const system = buildSystemPrompt(household, place, summarisePolicy(household.policy), {
    requestingMember: member,
    placeReason: resolution.reason,
    now: now(),
    maxToolCalls: maxCalls,
  });
  const messages: LlmMessage[] = [
    {
      role: 'user',
      content: userMessage(
        request,
        member,
        place,
        resolution,
        hintsFor(request, household, place),
        existingLines.join('\n'),
      ),
    },
  ];
  const sensitive = sensitiveStrings(household, place);
  const deadline = startedAt + maxWallMs;
  const remaining = () => deadline - performance.now();
  let wallHit = false;
  const TIMED_OUT: ToolResult = {
    ok: false,
    error: { kind: 'timeout', message: `the ${Math.round(maxWallMs / 1000)} s wall-time cap was reached` },
  };
  const runTimed = async (use: { name: string; input: unknown }): Promise<{ result: ToolResult; ms: number }> => {
    const t0 = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(
        () => {
          wallHit = true;
          resolve(TIMED_OUT);
        },
        Math.max(0, remaining()),
      );
    });
    try {
      const result = await Promise.race([executeTool(use.name, use.input, env), limit]);
      return { result, ms: Math.round(performance.now() - t0) };
    } finally {
      clearTimeout(timer);
    }
  };
  const onlySupplier = serviceable.suppliers.length === 1 ? serviceable.suppliers[0]!.id : 'the store';

  let toolCalls = 0;
  let finalText = '';
  let completed = false; // the model ended its turn normally
  let abnormal: Abnormal | undefined;
  let lastFailure: FailureNote | undefined; // latest supplier-facing failure, for the deterministic summary
  const buildErrorCounts = new Map<string, number>();
  const incomplete = () => !state.gateLine && state.questions.length === 0;

  for (let turn = 0; turn < maxCalls + 3; turn++) {
    if (remaining() <= 0) {
      abnormal = { kind: 'wall_time' };
      break;
    }
    const budgetSpent = toolCalls >= maxCalls;
    let response: LlmResponse;
    try {
      response = await deps.llm.create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        tools: TOOL_SPECS,
        messages,
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining()))),
        ...(budgetSpent ? { tool_choice: { type: 'none' as const } } : {}),
      });
    } catch (e) {
      log('llm_failed', errMessage(e));
      abnormal = remaining() <= 0 ? { kind: 'wall_time' } : { kind: 'llm_error', detail: errMessage(e) };
      break;
    }
    if (response.usage) {
      usageReported = true;
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
    }
    usage.llmCalls++;
    messages.push({ role: 'assistant', content: response.content });
    const text = textOf(response.content);
    const uses = response.content.filter(
      (b): b is Extract<AssistantBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (uses.length === 0) {
      if (response.stop_reason === 'max_tokens') {
        abnormal = { kind: 'no_final_text', detail: 'answer cut off at max_tokens' };
      } else {
        finalText = text;
        completed = true;
        // A text-only answer forced by an exhausted budget is only a real answer if the job got done.
        if (budgetSpent && incomplete()) abnormal = { kind: 'budget' };
      }
      break;
    }
    if (budgetSpent) {
      // The model ignored tool_choice: none.
      abnormal = { kind: 'budget' };
      break;
    }

    // Run this turn's tool calls. Read-only calls run concurrently; calls that touch cart, gate or question state run
    // afterwards in the model's order. Results go back in one user message, in tool_use order.
    const allowed = uses.slice(0, Math.max(0, maxCalls - toolCalls));
    const allowedIds = new Set(allowed.map((u) => u.id));
    toolCalls += allowed.length;
    const done = new Map<string, { result: ToolResult; ms: number }>();
    await Promise.all(
      allowed.filter((u) => isReadOnlyTool(u.name)).map(async (u) => done.set(u.id, await runTimed(u))),
    );
    for (const u of allowed.filter((x) => !isReadOnlyTool(x.name))) {
      done.set(u.id, wallHit ? { result: TIMED_OUT, ms: 0 } : await runTimed(u));
    }

    const results: ToolResultBlock[] = [];
    for (const use of uses) {
      if (!allowedIds.has(use.id)) {
        const result: ToolResult = {
          ok: false,
          error: `tool budget of ${maxCalls} calls is spent; write your final summary now`,
        };
        toolTrace.push({ name: use.name, ms: 0, ok: false, errorKind: 'budget' });
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: JSON.stringify(result) });
        continue;
      }
      const { result, ms } = done.get(use.id)!;
      trace.push({ tool: use.name, input: use.input, result });
      const err = errorOf(result);
      toolTrace.push({
        name: use.name,
        ms,
        ok: result.ok,
        ...(err
          ? { errorKind: err.kind, ...(err.message ? { errorMessage: scrub(err.message, sensitive) } : {}) }
          : {}),
      });
      if (err && (use.name === 'build_cart' || use.name === 'search_many')) {
        lastFailure = { kind: err.kind, message: scrub(err.message, sensitive, 200), supplier: onlySupplier };
      } else if (use.name === 'build_cart' && result.ok) {
        lastFailure = undefined;
      }
      if (err && use.name === 'build_cart') {
        const key = `${err.kind}\u0000${err.message}`;
        const n = (buildErrorCounts.get(key) ?? 0) + 1;
        buildErrorCounts.set(key, n);
        if (n >= 2) abnormal = { kind: 'repeated_error', detail: `${err.kind}: ${err.message}` };
      }
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(result),
        ...(result.ok ? {} : { is_error: true }),
      });
    }
    messages.push({ role: 'user', content: results });
    if (abnormal) break;
    if (wallHit || remaining() <= 0) {
      abnormal = { kind: 'wall_time' };
      break;
    }
    if (state.stop) {
      finalText = text;
      completed = true;
      break;
    }
  }
  if (!completed && !abnormal) abnormal = { kind: 'budget' }; // ran out of turns

  // The model's final text is used only on a normal finish, minus any trailing "let me..." narration.
  let cleanText = '';
  if (!abnormal) {
    const c = cleanFinalText(finalText);
    cleanText = c.text;
    if (c.midPlan && !state.stop) abnormal = { kind: 'no_final_text', detail: 'final message ended mid-plan' };
  }

  // 5. A built cart meets the gate, unless the run went wrong: then nothing is submitted behind the user's back.
  const questions = [...state.questions];
  if (!abnormal && questions.length === 0 && state.quotes.size > 0 && !state.proposed) {
    const cheapest = [...state.quotes.values()].sort((a, b) => a.total - b.total)[0]!;
    const r = await proposeCheckoutFor(env, cheapest.supplierId, cheapest.hash);
    trace.push({ tool: 'propose_checkout (loop)', input: { quoteHash: cheapest.hash }, result: r });
  }

  // 6. Reconcile leftovers.
  let finalCarts = new Map<SupplierId, Quote>(state.quotes);
  if (state.quotes.size === 0 && questions.length === 0 && completed && !abnormal) {
    // Nothing was built and nothing is pending: the existing carts are not justified by this request.
    for (const s of serviceable.suppliers) {
      if (!state.existingCarts.get(s.id)?.lines.length) continue;
      try {
        await s.clearCart();
      } catch (e) {
        log('clear_cart_failed', { supplier: s.id, error: errMessage(e) });
        finalCarts = new Map([...finalCarts, [s.id, state.existingCarts.get(s.id)!]]); // still there; do not report
      }
    }
  } else if (state.quotes.size === 0) {
    finalCarts = new Map(state.existingCarts); // untouched (questions pending, or the run failed)
  } else {
    // build_cart replaced these suppliers' carts; suppliers we did not build for keep theirs.
    for (const [id, cart] of state.existingCarts) if (!finalCarts.has(id)) finalCarts.set(id, cart);
  }
  const removedFromCart = reconcile(state.existingCarts, finalCarts, sanitiseLog);

  // 7. Summary.
  const quotes = [...state.quotes.values()];
  const parts: string[] = [];
  let body = cleanText;
  if (abnormal) {
    // Deterministic: never the model's narration.
    const why = abnormalReason(abnormal, lastFailure, maxCalls, maxWallMs);
    const cart = state.chosen
      ? `cart of ${state.chosen.lines.length} item(s), ${formatINR(state.chosen.total)}`
      : quotes.length > 0
        ? `cart of ${quotes[0]!.lines.length} item(s), ${formatINR(quotes[0]!.total)}`
        : '';
    if (abnormal.kind === 'no_final_text' && state.chosen && state.gateLine) body = `${capitalise(cart)}.`;
    else if (state.order) body = `I stopped before finishing (${why}), but a ${cart} was placed.`;
    else if (cart) body = `I couldn't finish — ${why}. A ${cart} was priced but not submitted. Nothing was ordered.`;
    else body = `I couldn't build the cart — ${why}. Nothing was ordered.`;
  } else if (body === '') {
    body = state.chosen
      ? `Cart of ${state.chosen.lines.length} item(s), ${formatINR(state.chosen.total)}.`
      : questions.length > 0
        ? 'I need a few answers before I can build the cart.'
        : 'I could not build a cart for that request.';
  }
  if (!body.toLowerCase().includes(place.nickname.toLowerCase())) body = `For ${place.nickname}: ${body}`;
  parts.push(body);
  if (questions.length > 0) parts.push(`Waiting for your answer: ${questions.join(' ')}`);
  if (removedFromCart.length > 0 && !/removed/i.test(body)) {
    parts.push(`Removed from the existing cart: ${listRemoved(removedFromCart)}.`);
  }
  if (sanitiseLog.count > 0) {
    parts.push(
      `Ignored instruction-like text found in ${sanitiseLog.count} supplier field(s); it was not acted on (e.g. "${sanitiseLog.entries[0]!.removed[0]!.slice(0, 80)}").`,
    );
  }
  const last =
    state.gateLine ??
    (state.chosen && state.decision
      ? gateLine({ decision: state.decision, quote: state.chosen, payment })
      : undefined) ??
    gateLineNotRun(
      questions.length > 0
        ? 'waiting for your answers'
        : quotes.length === 0
          ? 'no cart was built'
          : 'the cart was not submitted',
    );
  parts.push(last);

  const result: ShopResult = {
    requestId: request.id,
    placeId: place.id,
    placeReason: resolution.reason,
    quotes,
    ...(state.chosen ? { chosen: state.chosen } : {}),
    ...(state.decision ? { decision: state.decision } : {}),
    removedFromCart,
    questions,
    summary: parts.join(' '),
  };
  const failedGate = state.gateLine?.startsWith('Gate: ERROR') === true;
  const outcome: Outcome = state.order
    ? 'paid'
    : failedGate
      ? 'failed'
      : state.decision?.verdict === 'HOLD'
        ? 'held'
        : state.decision?.verdict === 'BLOCK'
          ? 'blocked'
          : quotes.length > 0
            ? 'quoted'
            : questions.length > 0
              ? 'asked'
              : 'failed';
  return finish(result, toolCalls, outcome, abnormal);
}

export async function runShopRequest(
  request: ShopRequest,
  deps: AgentDeps,
  opts: RunOptions = {},
): Promise<ShopResult> {
  return (await runShopRequestDetailed(request, deps, opts)).result;
}

/** Convenience for callers that build a request from raw text. */
export function makeRequest(
  input: Pick<ShopRequest, 'householdId' | 'memberId' | 'text'> & Partial<ShopRequest>,
  now: ISODateTime = new Date().toISOString(),
): ShopRequest {
  return {
    id: input.id ?? newId('req'),
    channel: 'web',
    receivedAt: now,
    ...input,
  };
}
