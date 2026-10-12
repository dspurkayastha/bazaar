/**
 * The only code path allowed to call Supplier.place (CONTRACTS.md non-negotiable 1).
 *
 * placeWithGate, all inside the household's GateLock (policy/lock.ts), so gate runs never interleave:
 *   0. idempotency: if this quote was already placed (same hash, placed at or after the quote was made), return
 *      that order without calling the supplier,
 *   1. re-reads the live supplier cart (Supplier.readCart),
 *   2. builds the PolicyContext around that live cart (the builder re-reads spend and approvals here, under the lock),
 *   3. calls the pure engine,
 *   4. records the decision (fail closed: if recording fails, nothing is placed),
 *   5. on PAY only, calls Supplier.place and records the order; otherwise throws PolicyHold / PolicyBlock
 *      (after the lock is released).
 */
import { BazaarError, PolicyBlock, PolicyHold, SupplierError } from '../core/errors.js';
import type {
  PaymentMethod,
  Place,
  PlacedOrder,
  PolicyContext,
  PolicyDecision,
  Quote,
  Supplier,
} from '../core/types.js';
import { unconsumed } from './context.js';
import { decide } from './engine.js';
import { processGateLock, type GateLock } from './lock.js';

export interface GateContextBuilder {
  /** The place the order is for; the live cart is read for this place. Its householdId keys the gate lock. */
  place: Place;
  /** The quote being gated, when known up front: lets the gate check idempotency before touching the supplier. */
  quote?: Quote;
  /**
   * Build the full context around the freshly read live cart: the quote the user saw, approvals (unconsumed only),
   * spend today / this month, quantity history, the requesting member, and `now`.
   * Called inside the gate lock: load spend and approvals HERE, not before calling the gate.
   * Whatever `liveCart` the builder returns is ignored; the gate always uses the cart it read itself.
   */
  build(liveCart: Quote): PolicyContext | Promise<PolicyContext>;
}

export interface GateRecord {
  householdId: string;
  placeId: string;
  memberId: string;
  quote: Quote;
  liveCart: Quote;
  decision: PolicyDecision;
  /** The approval that lifted a HOLD, if any. Absent on HOLD/BLOCK and on unattended PAY. */
  approvalId?: string;
  /** True when an approval was used to pay. */
  approvalUsed: boolean;
  /** PAY with no approval: counts toward the daily unattended cap. */
  unattended: boolean;
  evaluatedAt: string;
}

export interface PlacedRecord extends GateRecord {
  order: PlacedOrder;
  /** When set, the recorder MUST mark this approval consumed (approvals are single-use). */
  consumeApprovalId?: string;
}

/** An order the gate already placed for a quote. */
export interface ExistingPlacement {
  order: PlacedOrder;
  decision: PolicyDecision;
}

/** Injected persistence for the ledger. Implementations append; they never decide. */
export interface DecisionRecorder {
  /** Every evaluation, before anything is placed. Throwing here aborts the gate (fail closed). */
  recordDecision(record: GateRecord): void | Promise<void>;
  /** After a successful place: append the ledger order and mark `consumeApprovalId` consumed. */
  recordPlaced(record: PlacedRecord): void | Promise<void>;
  /**
   * Idempotency: the order the gate already placed for this quote, if any: a ledger order of this household with
   * the same quote hash, placed at or after `quote.createdAt`, not failed/cancelled. A re-quote of the same cart
   * later (new createdAt) is a new purchase and is not matched. Optional; without it the gate relies on the live
   * cart check alone.
   */
  findPlaced?(
    householdId: string,
    quote: Quote,
  ): ExistingPlacement | undefined | Promise<ExistingPlacement | undefined>;
}

export interface PlaceWithGateInput {
  supplier: Supplier;
  ctxBuilder: GateContextBuilder;
  payment: PaymentMethod;
  recorder: DecisionRecorder;
  /** Serialises gate runs per household. Defaults to the process-wide in-memory lock. */
  lock?: GateLock;
}

export interface GateResult {
  decision: PolicyDecision;
  order: PlacedOrder;
  /** True when the quote had already been placed: the existing order is returned and nothing was sent. */
  replayed?: boolean;
}

type Outcome =
  | { kind: 'placed'; result: GateResult }
  | { kind: 'hold'; decision: PolicyDecision; hash: string }
  | { kind: 'block'; decision: PolicyDecision; hash: string }
  | { kind: 'error'; error: unknown };

function asSupplierError(supplier: Supplier, op: string, err: unknown): Error {
  if (err instanceof BazaarError) return err;
  return new SupplierError(supplier.id, op, err instanceof Error ? err.message : String(err), { cause: err });
}

async function replayOf(recorder: DecisionRecorder, householdId: string, quote: Quote): Promise<Outcome | undefined> {
  if (!recorder.findPlaced) return undefined;
  const existing = await recorder.findPlaced(householdId, quote);
  return existing ? { kind: 'placed', result: { ...existing, replayed: true } } : undefined;
}

async function critical({ supplier, ctxBuilder, payment, recorder }: PlaceWithGateInput): Promise<Outcome> {
  const householdId = ctxBuilder.place.householdId;
  if (ctxBuilder.quote) {
    const replay = await replayOf(recorder, householdId, ctxBuilder.quote);
    if (replay) return replay;
  }

  let liveCart: Quote;
  try {
    liveCart = await supplier.readCart(ctxBuilder.place);
  } catch (err) {
    return { kind: 'error', error: asSupplierError(supplier, 'readCart', err) };
  }

  const built = await ctxBuilder.build(liveCart);
  if (built.place.id !== ctxBuilder.place.id) {
    throw new BazaarError('GATE_CONTEXT', `context place ${built.place.id} ≠ gated place ${ctxBuilder.place.id}`);
  }
  if (built.household.id !== householdId) {
    throw new BazaarError('GATE_CONTEXT', `context household ${built.household.id} ≠ the place's ${householdId}`);
  }
  if (built.quote.supplierId !== supplier.id) {
    throw new BazaarError('GATE_CONTEXT', `quote is for ${built.quote.supplierId}, not ${supplier.id}`);
  }
  if (!ctxBuilder.quote) {
    const replay = await replayOf(recorder, householdId, built.quote);
    if (replay) return replay;
  }
  // Approvals are single-use: whatever the builder passed, consumed ones never reach the engine.
  const ctx: PolicyContext = { ...built, liveCart, approvals: unconsumed(built.approvals) };
  const decision = decide(ctx);

  const approvalUsed = decision.verdict === 'PAY' && decision.approvalId !== undefined;
  const record: GateRecord = {
    householdId: ctx.household.id,
    placeId: ctx.place.id,
    memberId: ctx.requestingMember.id,
    quote: ctx.quote,
    liveCart,
    decision,
    ...(approvalUsed ? { approvalId: decision.approvalId } : {}),
    approvalUsed,
    unattended: decision.verdict === 'PAY' && !approvalUsed,
    evaluatedAt: decision.evaluatedAt,
  };
  // Fail closed: a throw here propagates and nothing is placed.
  await recorder.recordDecision(record);

  if (decision.verdict === 'BLOCK') return { kind: 'block', decision, hash: ctx.quote.hash };
  if (decision.verdict === 'HOLD') return { kind: 'hold', decision, hash: ctx.quote.hash };

  let order: PlacedOrder;
  try {
    order = await supplier.place(ctx.quote, payment);
  } catch (err) {
    // Never retry checkout here: a network error may still have placed the order (double-charge risk).
    return { kind: 'error', error: asSupplierError(supplier, 'place', err) };
  }
  try {
    await recorder.recordPlaced({
      ...record,
      order,
      ...(record.approvalId !== undefined ? { consumeApprovalId: record.approvalId } : {}),
    });
  } catch (err) {
    // The order exists at the supplier. Keep the recorded decision (do not roll the lock's transaction back) and
    // surface the failure; ledger ingest (Supplier.orders) reconciles the missing row.
    return { kind: 'error', error: err };
  }
  return { kind: 'placed', result: { decision, order } };
}

export async function placeWithGate(input: PlaceWithGateInput): Promise<GateResult> {
  const lock = input.lock ?? processGateLock;
  const outcome = await lock.run(input.ctxBuilder.place.householdId, () => critical(input));
  switch (outcome.kind) {
    case 'placed':
      return outcome.result;
    case 'block':
      throw new PolicyBlock(outcome.decision, outcome.hash);
    case 'hold':
      throw new PolicyHold(outcome.decision, outcome.hash);
    case 'error':
      throw outcome.error;
  }
}

/** True when a gate refusal means the cart changed and the agent must re-quote. */
export function needsRequote(err: unknown): boolean {
  return err instanceof PolicyBlock && err.decision.reasons.some((r) => r.rule === 'quote_mismatch');
}
