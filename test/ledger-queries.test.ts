import { describe, expect, it } from 'vitest';
import type { ItemCategory, LedgerOrderInput } from '../src/core/types.js';
import { summariseMonth } from '../src/ledger/queries.js';

let n = 0;
function order(
  placedAt: string,
  items: { total: number; category: ItemCategory; by?: string }[],
  fees: { label: string; amount: number }[],
  extra: Partial<LedgerOrderInput> = {},
): LedgerOrderInput {
  const itemSum = items.reduce((s, i) => s + i.total, 0);
  return {
    supplierId: 'instamart',
    supplierOrderId: `so_${++n}`,
    placedAt,
    placeId: 'pl_home',
    lines: items.map((i, k) => ({
      name: `item ${k}`,
      quantity: 1,
      unitPrice: i.total,
      lineTotal: i.total,
      category: i.category,
      ...(i.by ? { addedBy: i.by } : {}),
    })),
    fees,
    total: itemSum + fees.reduce((s, f) => s + f.amount, 0),
    status: 'placed',
    ...extra,
  };
}

const SMALL_FEES = [
  { label: 'handling', amount: 800 },
  { label: 'delivery', amount: 2400 },
];

describe('summariseMonth', () => {
  const orders: LedgerOrderInput[] = [
    // three small orders in October (IST), fees ₹32 each
    order('2026-10-02T05:00:00Z', [{ total: 12000, category: 'dairy', by: 'dev' }], SMALL_FEES),
    order('2026-10-05T05:00:00Z', [{ total: 15000, category: 'dairy', by: 'partner' }], SMALL_FEES, {
      placeId: 'pl_hosp',
    }),
    order('2026-10-09T05:00:00Z', [{ total: 18000, category: 'household', by: 'dev' }], SMALL_FEES),
    // one big order
    order(
      '2026-10-10T05:00:00Z',
      [
        { total: 90000, category: 'grocery', by: 'dev' },
        { total: 30000, category: 'meat', by: 'dev' },
      ],
      [
        { label: 'handling', amount: 800 },
        { label: 'delivery', amount: 1500 },
      ],
    ),
    // not October
    order('2026-09-30T05:00:00Z', [{ total: 50000, category: 'grocery', by: 'dev' }], []),
    // failed order: ignored
    order('2026-10-11T05:00:00Z', [{ total: 99900, category: 'grocery', by: 'dev' }], [], { status: 'failed' }),
  ];
  const s = summariseMonth(orders, '2026-10');

  it('counts only placed orders in the local month', () => {
    expect(s.orderCount).toBe(4);
    expect(s.total).toBe(12000 + 15000 + 18000 + 120000 + 3 * 3200 + 2300);
  });

  it('totals by category, place and member', () => {
    expect(s.byCategory).toEqual([
      { key: 'grocery', total: 90000, count: 1 },
      { key: 'meat', total: 30000, count: 1 },
      { key: 'dairy', total: 27000, count: 2 },
      { key: 'household', total: 18000, count: 1 },
    ]);
    expect(s.byPlace.map((b) => [b.key, b.count])).toEqual([
      ['pl_home', 3],
      ['pl_hosp', 1],
    ]);
    expect(s.byMember).toEqual([
      { key: 'dev', total: 150000, count: 4 },
      { key: 'partner', total: 15000, count: 1 },
    ]);
  });

  it('names members and places when asked', () => {
    const named = summariseMonth(orders, '2026-10', {
      memberNames: { dev: 'Dev' },
      placeNames: { pl_home: 'home' },
    });
    expect(named.byMember[0]!.key).toBe('Dev');
    expect(named.byPlace[0]!.key).toBe('home');
  });

  it('totals fees, by label', () => {
    expect(s.fees.total).toBe(3 * 3200 + 2300);
    expect(s.fees.byLabel).toEqual([
      { label: 'delivery', total: 3 * 2400 + 1500 },
      { label: 'handling', total: 4 * 800 },
    ]);
  });

  it('lists orders under ₹200 with their fees', () => {
    expect(s.smallOrders.count).toBe(3);
    expect(s.smallOrders.fees).toBe(9600);
    expect(s.smallOrders.orders.map((o) => [o.itemTotal, o.fees])).toEqual([
      [12000, 3200],
      [15000, 3200],
      [18000, 3200],
    ]);
  });

  it('estimates batching: fees on small orders minus one delivery fee per three', () => {
    // 9600 - 1 × 2400
    expect(s.smallOrders.batchingWouldHaveSaved).toBe(7200);
  });

  it('four small orders make two batches', () => {
    const four = [
      ...orders.slice(0, 3),
      order('2026-10-12T05:00:00Z', [{ total: 10000, category: 'dairy' }], SMALL_FEES),
    ];
    // 4 × 3200 - 2 × 2400
    expect(summariseMonth(four, '2026-10').smallOrders.batchingWouldHaveSaved).toBe(12800 - 4800);
  });

  it('one small order saves nothing', () => {
    expect(summariseMonth([orders[0]!], '2026-10').smallOrders.batchingWouldHaveSaved).toBe(0);
  });

  it('judges "under ₹200" on items, not on what was charged (configurable)', () => {
    const edge = order('2026-10-03T05:00:00Z', [{ total: 19000, category: 'dairy' }], SMALL_FEES); // ₹190 + ₹32
    expect(summariseMonth([edge], '2026-10').smallOrders.count).toBe(1);
    expect(summariseMonth([edge], '2026-10', { smallOrderBasis: 'total' }).smallOrders.count).toBe(0);
  });

  it('uses local (IST) months at the boundary', () => {
    const late = order('2026-09-30T19:00:00Z', [{ total: 10000, category: 'dairy' }], []); // 00:30 IST on 1 Oct
    expect(summariseMonth([late], '2026-10').orderCount).toBe(1);
    expect(summariseMonth([late], '2026-09').orderCount).toBe(0);
  });

  it('is empty-safe', () => {
    const e = summariseMonth([], '2026-10');
    expect(e.total).toBe(0);
    expect(e.byCategory).toEqual([]);
    expect(e.smallOrders.batchingWouldHaveSaved).toBe(0);
  });
});
