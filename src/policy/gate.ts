/**
 * The only code path allowed to call Supplier.place (CONTRACTS.md non-negotiable 1).
 *
 * placeWithGate:
 *   1. re-reads the live supplier cart (Supplier.readCart),
 *   2. builds the PolicyContext around that live cart,
 *   3. calls the pure engine,
 *   4. records the decision (fail closed: if recording fails, nothing is placed),
 *   5. on PAY only, calls Supplier.place; otherwise throws PolicyHold / PolicyBlock.
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

export interface GateContextBuilder {
  /** The place the order is for; the live cart is read for this place. */
  place: Place;
  /**
   * Build the full context around the freshly read live cart: the quote the user saw, approvals (unconsumed only),
   * spend today / this month, quantity history, the requesting member, and `now`.
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

/** Injected persistence for the ledger. Implementations append; they never decide. */
export interface DecisionRecorder {
  /** Every evaluation, before anything is placed. Throwing here aborts the gate (fail closed). */
  recordDecision(record: GateRecord): void | Promise<void>;
  /** After a successful place: append the ledger order and mark `consumeApprovalId` consumed. */
  recordPlaced(record: PlacedRecord): void | Promise<void>;
}

export interface PlaceWithGateInput {
  supplier: Supplier;
  ctxBuilder: GateContextBuilder;
  payment: PaymentMethod;
  recorder: DecisionRecorder;
}

export interface GateResult {
  decision: PolicyDecision;
  order: PlacedOrder;
}

function asSupplierError(supplier: Supplier, op: string, err: unknown): Error {
  if (err instanceof BazaarError) return err;
  return new SupplierError(supplier.id, op, err instanceof Error ? err.message : String(err), { cause: err });
}

export async function placeWithGate({
  supplier,
  ctxBuilder,
  payment,
  recorder,
}: PlaceWithGateInput): Promise<GateResult> {
  let liveCart: Quote;
  try {
    liveCart = await supplier.readCart(ctxBuilder.place);
  } catch (err) {
    throw asSupplierError(supplier, 'readCart', err);
  }

  const built = await ctxBuilder.build(liveCart);
  if (built.place.id !== ctxBuilder.place.id) {
    throw new BazaarError('GATE_CONTEXT', `context place ${built.place.id} ≠ gated place ${ctxBuilder.place.id}`);
  }
  if (built.quote.supplierId !== supplier.id) {
    throw new BazaarError('GATE_CONTEXT', `quote is for ${built.quote.supplierId}, not ${supplier.id}`);
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
  await recorder.recordDecision(record);

  if (decision.verdict === 'BLOCK') throw new PolicyBlock(decision, ctx.quote.hash);
  if (decision.verdict === 'HOLD') throw new PolicyHold(decision, ctx.quote.hash);

  let order: PlacedOrder;
  try {
    order = await supplier.place(ctx.quote, payment);
  } catch (err) {
    // Never retry checkout here: a network error may still have placed the order (double-charge risk).
    throw asSupplierError(supplier, 'place', err);
  }
  await recorder.recordPlaced({
    ...record,
    order,
    ...(record.approvalId !== undefined ? { consumeApprovalId: record.approvalId } : {}),
  });
  return { decision, order };
}

/** True when a gate refusal means the cart changed and the agent must re-quote. */
export function needsRequote(err: unknown): boolean {
  return err instanceof PolicyBlock && err.decision.reasons.some((r) => r.rule === 'quote_mismatch');
}
