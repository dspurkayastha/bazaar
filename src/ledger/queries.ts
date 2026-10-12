/**
 * Monthly spend summary over ledger rows. Pure: callers load LedgerOrderInput rows (any superset of the month).
 *
 * Decisions CONTRACTS.md left open:
 *  - Orders that failed/cancelled/refunded do not count (same rule as the policy spend helpers).
 *  - Months are local (Asia/Kolkata by default), like the caps.
 *  - byCategory and byMember sum LINE totals (fees are not attributable to a category or a person);
 *    byPlace sums ORDER totals (items + fees), since the delivery went to that place.
 *  - "Small order" = item subtotal (total - fees) under ₹200, so a fee cannot lift an order out of the bucket.
 *    Set `smallOrderBasis: 'total'` to judge by the amount charged instead.
 *  - Batching estimate = fees paid on small orders - one delivery fee per group of three small orders
 *    (ceil(n / 3) groups, each priced at the small orders' average delivery fee). Never negative; 0 below 2 orders.
 */
import { localMonth, countsAsSpend, DEFAULT_TIMEZONE } from '../policy/spend.js';
import type { LedgerOrderInput, Paise } from '../core/types.js';

export const SMALL_ORDER_PAISE: Paise = 20_000; // ₹200

export interface SpendBucket {
  key: string;
  total: Paise;
  /** Number of orders (byPlace) or lines (byCategory, byMember) in the bucket. */
  count: number;
}

export interface SmallOrder {
  supplierId: string;
  supplierOrderId: string;
  placedAt: string;
  placeId?: string;
  itemTotal: Paise;
  total: Paise;
  fees: Paise;
}

export interface MonthlySummary {
  month: string;
  orderCount: number;
  /** Everything charged: items + fees. */
  total: Paise;
  itemTotal: Paise;
  byCategory: SpendBucket[];
  byPlace: SpendBucket[];
  byMember: SpendBucket[];
  fees: { total: Paise; byLabel: { label: string; total: Paise }[] };
  smallOrders: {
    thresholdPaise: Paise;
    count: number;
    fees: Paise;
    orders: SmallOrder[];
    /** Estimated fees avoided had these been batched three to an order. */
    batchingWouldHaveSaved: Paise;
  };
}

export interface SummaryOptions {
  tz?: string;
  smallOrderPaise?: Paise;
  smallOrderBasis?: 'items' | 'total';
  /** Optional member id → display name. */
  memberNames?: Record<string, string>;
  /** Optional place id → nickname. */
  placeNames?: Record<string, string>;
}

const UNKNOWN = 'unknown';

function bump(map: Map<string, { total: number; count: number }>, key: string, amount: number): void {
  const cur = map.get(key) ?? { total: 0, count: 0 };
  cur.total += amount;
  cur.count += 1;
  map.set(key, cur);
}

function toBuckets(map: Map<string, { total: number; count: number }>, names?: Record<string, string>): SpendBucket[] {
  return [...map.entries()]
    .map(([key, v]) => ({ key: names?.[key] ?? key, total: v.total, count: v.count }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

export function sumFees(fees: { amount: number }[]): Paise {
  return fees.reduce((s, f) => s + f.amount, 0);
}

export function batchingSavings(small: SmallOrder[], feesByOrder: { label: string; amount: number }[][]): Paise {
  const n = small.length;
  if (n < 2) return 0;
  const allFees = small.reduce((s, o) => s + o.fees, 0);
  let deliveryTotal = 0;
  let deliveryOrders = 0;
  for (const fees of feesByOrder) {
    const d = fees.filter((f) => /deliver/i.test(f.label)).reduce((s, f) => s + f.amount, 0);
    if (d > 0) {
      deliveryTotal += d;
      deliveryOrders += 1;
    }
  }
  // No labelled delivery fee: fall back to the average whole-order fee.
  const avgDelivery = deliveryOrders > 0 ? deliveryTotal / deliveryOrders : allFees / n;
  const groups = Math.ceil(n / 3);
  return Math.max(0, Math.round(allFees - groups * avgDelivery));
}

export function summariseMonth(
  orders: readonly LedgerOrderInput[],
  month: string,
  opts: SummaryOptions = {},
): MonthlySummary {
  const tz = opts.tz ?? DEFAULT_TIMEZONE;
  const threshold = opts.smallOrderPaise ?? SMALL_ORDER_PAISE;
  const basis = opts.smallOrderBasis ?? 'items';

  const inMonth = orders.filter((o) => countsAsSpend(o) && localMonth(o.placedAt, tz) === month);

  const byCategory = new Map<string, { total: number; count: number }>();
  const byPlace = new Map<string, { total: number; count: number }>();
  const byMember = new Map<string, { total: number; count: number }>();
  const feeLabels = new Map<string, number>();
  const small: SmallOrder[] = [];
  const smallFees: { label: string; amount: number }[][] = [];
  let total = 0;
  let itemTotal = 0;
  let feeTotal = 0;

  for (const o of inMonth) {
    const fees = sumFees(o.fees);
    const items = o.total - fees;
    total += o.total;
    itemTotal += items;
    feeTotal += fees;
    for (const f of o.fees) feeLabels.set(f.label, (feeLabels.get(f.label) ?? 0) + f.amount);
    bump(byPlace, o.placeId ?? UNKNOWN, o.total);
    for (const l of o.lines) {
      bump(byCategory, l.category ?? 'other', l.lineTotal);
      bump(byMember, l.addedBy ?? UNKNOWN, l.lineTotal);
    }
    if ((basis === 'items' ? items : o.total) < threshold) {
      small.push({
        supplierId: o.supplierId,
        supplierOrderId: o.supplierOrderId,
        placedAt: o.placedAt,
        ...(o.placeId !== undefined ? { placeId: o.placeId } : {}),
        itemTotal: items,
        total: o.total,
        fees,
      });
      smallFees.push(o.fees);
    }
  }

  return {
    month,
    orderCount: inMonth.length,
    total,
    itemTotal,
    byCategory: toBuckets(byCategory),
    byPlace: toBuckets(byPlace, opts.placeNames),
    byMember: toBuckets(byMember, opts.memberNames),
    fees: {
      total: feeTotal,
      byLabel: [...feeLabels.entries()]
        .map(([label, t]) => ({ label, total: t }))
        .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
    },
    smallOrders: {
      thresholdPaise: threshold,
      count: small.length,
      fees: small.reduce((s, o) => s + o.fees, 0),
      orders: small.sort((a, b) => a.placedAt.localeCompare(b.placedAt)),
      batchingWouldHaveSaved: batchingSavings(small, smallFees),
    },
  };
}

/** 'YYYY-MM' of `now` in local time, the default for GET /ledger/summary. */
export function currentMonth(now: string, tz: string = DEFAULT_TIMEZONE): string {
  return localMonth(now, tz);
}
