/**
 * What the web app shows on its carts screen (GET /api/carts), computed from gate activity. Pure: no I/O.
 *
 * A cart is "held" when, for its quote hash:
 *   - the newest gate decision is HOLD, or BLOCK for a reason other than quote_mismatch (a stale cart is noise),
 *   - that decision was made on the current stored quote (not before a re-quote of the same hash),
 *   - it has not been placed or rejected since that quote was made.
 * The member who built it is the requester of the first gate run on that quote (an owner's later approval attempt
 * runs the gate as the owner and must not take the cart away from the adder who built it).
 * Visibility: owners see every member's held carts; everyone else sees their own.
 */
import type { GateActivity } from '../auth/types.js';
import { sanitiseText } from '../core/sanitise.js';
import type { Household, ISODateTime, LedgerOrderInput, Member, Paise, SupplierId } from '../core/types.js';

export interface HeldCart {
  quoteHash: string;
  member: { id: string; name: string };
  place: { id: string; nickname: string };
  supplier: SupplierId;
  lines: { name: string; label: string; qty: number; lineTotal: Paise }[];
  fees: { label: string; amount: Paise }[];
  total: Paise;
  etaMinutes?: number;
  createdAt: ISODateTime;
  reasons: string[];
  needsPin: boolean;
  approvable: boolean;
}

export interface OrderSummary {
  supplierOrderId: string;
  placedAt: ISODateTime;
  place: { id: string; nickname: string } | null;
  total: Paise;
  status: string;
  member: { id: string; name: string } | null;
}

/** How far back the carts screen looks for held carts. */
export const HELD_WINDOW_MS = 24 * 3_600_000;

const clean = (s: string) => sanitiseText(s).text;

export function heldCarts(
  activity: GateActivity,
  household: Household,
  viewer: Pick<Member, 'id' | 'role'>,
  pinThresholdPaise: Paise,
): HeldCart[] {
  const quotes = new Map(activity.quotes.map((q) => [q.hash, q]));
  const byHash = new Map<string, GateActivity['decisions']>();
  for (const d of activity.decisions) byHash.set(d.quoteHash, [...(byHash.get(d.quoteHash) ?? []), d]);
  const out: HeldCart[] = [];
  for (const [hash, ds] of byHash) {
    const quote = quotes.get(hash);
    if (!quote) continue;
    const current = ds
      .filter((d) => d.decision.evaluatedAt >= quote.createdAt)
      .sort((a, b) => a.decision.evaluatedAt.localeCompare(b.decision.evaluatedAt));
    const latest = current.at(-1);
    const first = current[0];
    if (!latest || !first) continue;
    const { verdict, reasons } = latest.decision;
    if (verdict === 'PAY') continue;
    if (verdict === 'BLOCK' && reasons.some((r) => r.rule === 'quote_mismatch')) continue;
    if (activity.placed.some((p) => p.quoteHash === hash && p.placedAt >= quote.createdAt)) continue;
    if (activity.rejections.some((r) => r.quoteHash === hash && r.rejectedAt >= quote.createdAt)) continue;
    const builderId = first.memberId;
    if (viewer.role !== 'owner' && builderId !== viewer.id) continue;
    const builder = household.members.find((m) => m.id === builderId);
    const place = household.places.find((p) => p.id === quote.placeId);
    out.push({
      quoteHash: hash,
      member: { id: builderId, name: builder?.name ?? 'unknown' },
      place: { id: quote.placeId, nickname: place?.nickname ?? 'unknown place' },
      supplier: quote.supplierId,
      lines: quote.lines.map((l) => ({
        name: clean(l.name),
        label: clean(l.label),
        qty: l.quantity,
        lineTotal: l.lineTotal,
      })),
      fees: quote.fees.map((f) => ({ label: clean(f.label), amount: f.amount })),
      total: quote.total,
      ...(quote.etaMinutes !== undefined ? { etaMinutes: quote.etaMinutes } : {}),
      createdAt: quote.createdAt,
      reasons: reasons.map((r) => r.detail),
      needsPin: quote.total > pinThresholdPaise,
      approvable: viewer.role === 'owner' && verdict === 'HOLD',
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Recent orders for the carts screen: owners see the household's, others their own. Newest first. */
export function recentOrders(
  orders: readonly LedgerOrderInput[],
  household: Household,
  viewer: Pick<Member, 'id' | 'role'>,
  limit = 20,
): OrderSummary[] {
  return orders
    .filter((o) => viewer.role === 'owner' || o.memberId === viewer.id)
    .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
    .slice(0, limit)
    .map((o) => {
      const place = o.placeId ? household.places.find((p) => p.id === o.placeId) : undefined;
      const member = o.memberId ? household.members.find((m) => m.id === o.memberId) : undefined;
      return {
        supplierOrderId: o.supplierOrderId,
        placedAt: o.placedAt,
        place: place ? { id: place.id, nickname: place.nickname } : null,
        total: o.total,
        status: o.status,
        member: member ? { id: member.id, name: member.name } : null,
      };
    });
}

/**
 * The ledger as a non-owner may see it: only the lines they added (and whole orders they placed). An order they
 * only added lines to keeps just those lines, with no fees, and its total becomes those lines' sum.
 */
export function ownLedger(orders: readonly LedgerOrderInput[], memberId: string): LedgerOrderInput[] {
  const out: LedgerOrderInput[] = [];
  for (const o of orders) {
    if (o.memberId === memberId) {
      out.push(o);
      continue;
    }
    const lines = o.lines.filter((l) => l.addedBy === memberId);
    if (lines.length === 0) continue;
    out.push({ ...o, lines, fees: [], total: lines.reduce((s, l) => s + l.lineTotal, 0) });
  }
  return out;
}
