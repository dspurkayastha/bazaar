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
  /** Webhook-originated request: see PolicyContext.webhook. */
  webhook?: PolicyContext['webhook'];
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
    ...(inputs.webhook ? { webhook: inputs.webhook } : {}),
  };
}

/** A GateContextBuilder over already-loaded inputs. */
export function contextBuilder(inputs: PolicyInputs): GateContextBuilder {
  return { place: inputs.place, quote: inputs.quote, build: (liveCart) => buildPolicyContext(inputs, liveCart) };
}

/** Where a gate run re-reads its mutable inputs (the agent Store satisfies this). */
export interface GateInputsSource {
  loadApprovals(quote: Quote): Promise<Approval[]>;
  loadSpendRows(householdId: string, since: ISODateTime): Promise<SpendRow[]>;
  loadQuantityHistory(householdId: string, now: ISODateTime): Promise<Record<string, number>>;
}

/** Enough history for "this local month" plus timezone slack. */
export const SPEND_LOOKBACK_MS = 33 * 24 * 3_600_000;

/**
 * A GateContextBuilder that loads approvals, spend and quantity history when the gate calls build(), i.e. inside
 * the household's gate lock, so the caps see every order recorded before this run (review 5a).
 * `approvals: false` evaluates with no approvals at all (webhook-originated requests can never use one).
 */
export function loadingContextBuilder(
  source: GateInputsSource,
  inputs: Omit<PolicyInputs, 'approvals' | 'ledger' | 'quantityHistory'> & { approvals?: boolean },
): GateContextBuilder {
  const { approvals: useApprovals = true, ...rest } = inputs;
  return {
    place: inputs.place,
    quote: inputs.quote,
    build: async (liveCart) => {
      const since = new Date(Date.parse(inputs.now) - SPEND_LOOKBACK_MS).toISOString();
      const [approvals, ledger, quantityHistory] = await Promise.all([
        useApprovals ? source.loadApprovals(inputs.quote) : Promise.resolve([]),
        source.loadSpendRows(inputs.household.id, since),
        source.loadQuantityHistory(inputs.household.id, inputs.now),
      ]);
      return buildPolicyContext({ ...rest, approvals, ledger, quantityHistory }, liveCart);
    },
  };
}
