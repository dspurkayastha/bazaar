/**
 * Builds a PolicyContext from raw household state. Pure; the caller loads the inputs (DB or fixtures).
 * Encodes the amended contract: only unconsumed approvals reach the engine; spendToday counts unattended orders
 * only; spendThisMonth counts every placed order.
 */
import type { Approval, Household, ISODateTime, Member, Place, PolicyContext, Quote } from '../core/types.js';
import type { GateContextBuilder } from './gate.js';
import { DEFAULT_TIMEZONE, capSpend, type SpendRow } from './spend.js';

export interface PolicyInputs {
  household: Household;
  place: Place;
  /** The quote the user saw / approved. */
  quote: Quote;
  approvals: readonly Approval[];
  requestingMember: Member;
  /** Ledger orders for at least the current local month. */
  ledger: readonly SpendRow[];
  quantityHistory: Record<string, number>;
  now: ISODateTime;
  tz?: string;
}

export function unconsumed(approvals: readonly Approval[]): Approval[] {
  return approvals.filter((a) => a.consumedAt === undefined || a.consumedAt === null);
}

export function buildPolicyContext(inputs: PolicyInputs, liveCart: Quote): PolicyContext {
  const { spendToday, spendThisMonth } = capSpend(inputs.ledger, inputs.now, inputs.tz ?? DEFAULT_TIMEZONE);
  return {
    household: inputs.household,
    place: inputs.place,
    quote: inputs.quote,
    liveCart,
    approvals: unconsumed(inputs.approvals),
    requestingMember: inputs.requestingMember,
    spendToday,
    spendThisMonth,
    quantityHistory: inputs.quantityHistory,
    now: inputs.now,
  };
}

/** A GateContextBuilder over already-loaded inputs. */
export function contextBuilder(inputs: PolicyInputs): GateContextBuilder {
  return { place: inputs.place, build: (liveCart) => buildPolicyContext(inputs, liveCart) };
}
