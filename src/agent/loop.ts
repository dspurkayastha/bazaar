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
import { modelFromEnv, type AssistantBlock, type LlmClient, type LlmMessage, type ToolResultBlock } from './llm.js';
import { buildSystemPrompt, summarisePolicy } from './prompts.js';
import type { Store } from './store.js';
import {
  TOOL_SPECS,
  executeTool,
  gateLine,
  gateLineNotRun,
  newRunState,
  proposeCheckoutFor,
  quoteView,
  type RunState,
  type ToolEnv,
} from './tools.js';

export const MAX_TOOL_CALLS = 12;
const MAX_TOKENS = 1500;

export interface AgentDeps {
  store: Store;
  suppliers: Supplier[];
  llm: LlmClient;
  /** Defaults to ANTHROPIC_MODEL, then claude-sonnet-4-5. */
  model?: string;
  maxToolCalls?: number;
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
  const payment: PaymentMethod = deps.payment ?? { kind: 'cod' };
  const trace: TraceEntry[] = [];

  const household = await deps.store.loadHousehold(request.householdId);
  const member = household.members.find((m) => m.id === request.memberId);
  if (!member)
    throw new BazaarError('UNKNOWN_MEMBER', `member ${request.memberId} is not in household ${household.id}`);
  await deps.store.saveRequest(request);

  const finish = async (result: ShopResult, toolCalls: number): Promise<ShopOutcome> => {
    try {
      await deps.store.saveResult(result);
    } catch (e) {
      // The order (if any) is already placed and recorded by the gate; do not turn that into a failure.
      log('save_result_failed', errMessage(e));
    }
    return { result, trace, toolCalls, sanitiseLog };
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

  // 4. The tool-use loop.
  const system = buildSystemPrompt(household, place, summarisePolicy(household.policy), {
    requestingMember: member,
    placeReason: resolution.reason,
    now: now(),
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
  const model = deps.model ?? modelFromEnv();
  let toolCalls = 0;
  let finalText = '';
  let completed = false; // the model ended its turn normally

  for (let turn = 0; turn < maxCalls + 3; turn++) {
    const budgetSpent = toolCalls >= maxCalls;
    let response;
    try {
      response = await deps.llm.create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        tools: TOOL_SPECS,
        messages,
        ...(budgetSpent ? { tool_choice: { type: 'none' as const } } : {}),
      });
    } catch (e) {
      log('llm_failed', errMessage(e));
      break;
    }
    messages.push({ role: 'assistant', content: response.content });
    const text = textOf(response.content);
    const uses = response.content.filter(
      (b): b is Extract<AssistantBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (uses.length === 0) {
      finalText = text;
      completed = true;
      break;
    }
    if (budgetSpent) {
      // The model ignored tool_choice: none. Stop; code finishes the job.
      finalText = text;
      break;
    }

    const results: ToolResultBlock[] = [];
    for (const use of uses) {
      if (toolCalls >= maxCalls) {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: JSON.stringify({
            ok: false,
            error: `tool budget of ${maxCalls} calls is spent; write your final summary now`,
          }),
        });
        continue;
      }
      toolCalls++;
      const result = await executeTool(use.name, use.input, env);
      trace.push({ tool: use.name, input: use.input, result });
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(result),
        ...(result.ok ? {} : { is_error: true }),
      });
    }
    messages.push({ role: 'user', content: results });
    if (state.stop) {
      finalText = text;
      completed = true;
      break;
    }
  }

  // 5. A built cart always meets the gate.
  const questions = [...state.questions];
  if (questions.length === 0 && state.quotes.size > 0 && !state.proposed) {
    const cheapest = [...state.quotes.values()].sort((a, b) => a.total - b.total)[0]!;
    const r = await proposeCheckoutFor(env, cheapest.supplierId, cheapest.hash);
    trace.push({ tool: 'propose_checkout (loop)', input: { quoteHash: cheapest.hash }, result: r });
  }

  // 6. Reconcile leftovers.
  let finalCarts = new Map<SupplierId, Quote>(state.quotes);
  if (state.quotes.size === 0 && questions.length === 0 && completed) {
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
  let body = stripGateLines(finalText);
  if (body === '') {
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
  return finish(result, toolCalls);
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
