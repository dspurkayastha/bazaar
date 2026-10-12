import { describe, expect, it } from 'vitest';
import {
  capSpend,
  countsAsSpend,
  isUnattended,
  localDate,
  localMonth,
  spendThisMonth,
  spendToday,
} from '../src/policy/spend.js';

const rows = [
  // 31 Oct 23:00 IST = 31 Oct 17:30 UTC → October
  { placedAt: '2026-10-31T17:30:00.000Z', total: 30000, status: 'DELIVERED' },
  // 31 Oct 18:45 UTC = 1 Nov 00:15 IST → November, although the UTC date is still 31 Oct
  { placedAt: '2026-10-31T18:45:00.000Z', total: 41200, status: 'placed' },
  // 1 Nov 10:00 IST
  { placedAt: '2026-11-01T04:30:00.000Z', total: 112300, status: 'pending_payment' },
  // Cancelled and failed orders never count
  { placedAt: '2026-11-01T05:00:00.000Z', total: 99900, status: 'CANCELLED' },
  { placedAt: '2026-11-01T05:10:00.000Z', total: 99900, status: 'failed' },
  // 2 Nov 00:05 IST = 1 Nov 18:35 UTC → next day in IST
  { placedAt: '2026-11-01T18:35:00.000Z', total: 5000, status: 'DELIVERED' },
];

describe('spend helpers (Asia/Kolkata)', () => {
  it('maps instants to IST calendar dates', () => {
    expect(localDate('2026-10-31T18:29:59.000Z')).toBe('2026-10-31');
    expect(localDate('2026-10-31T18:30:00.000Z')).toBe('2026-11-01');
    expect(localMonth('2026-10-31T18:30:00.000Z')).toBe('2026-11');
    expect(localDate('2026-10-31T18:30:00.000Z', 'UTC')).toBe('2026-10-31');
  });

  it('sums today across the IST midnight that is still "yesterday" in UTC', () => {
    // now = 1 Nov 12:00 IST
    const now = '2026-11-01T06:30:00.000Z';
    expect(spendToday(rows, now)).toBe(41200 + 112300);
    // Bucketing by UTC would be wrong both ways: it drops the 00:15 IST order (31 Oct in UTC)
    // and pulls in the 2 Nov 00:05 IST order (still 1 Nov in UTC).
    expect(spendToday(rows, now, { tz: 'UTC' })).toBe(112300 + 5000);
  });

  it('sums this month across the month boundary in IST', () => {
    expect(spendThisMonth(rows, '2026-11-01T06:30:00.000Z')).toBe(41200 + 112300 + 5000);
    expect(spendThisMonth(rows, '2026-10-31T12:00:00.000Z')).toBe(30000);
    // 31 Oct 23:59 IST is still October
    expect(spendThisMonth(rows, '2026-10-31T18:29:00.000Z')).toBe(30000);
  });

  it('supports an extra filter (e.g. unattended only)', () => {
    const tagged = rows.map((r, i) => ({ ...r, approved: i === 2 }));
    expect(spendToday(tagged, '2026-11-01T06:30:00.000Z', { where: (r) => !r.approved })).toBe(41200);
  });

  it('capSpend: daily counts unattended gate orders only; monthly counts every placed order', () => {
    const now = '2026-11-01T06:30:00.000Z';
    const mixed = [
      { placedAt: '2026-11-01T03:00:00.000Z', total: 30000, status: 'placed', decision: { verdict: 'PAY' as const } },
      {
        placedAt: '2026-11-01T03:10:00.000Z',
        total: 112300,
        status: 'placed',
        decision: { verdict: 'PAY' as const, approvalId: 'ap_1' },
      },
      { placedAt: '2026-11-01T04:00:00.000Z', total: 50000, status: 'DELIVERED' }, // placed in the app
      { placedAt: '2026-11-01T04:30:00.000Z', total: 9900, status: 'CANCELLED', decision: { verdict: 'PAY' as const } },
      { placedAt: '2026-10-31T04:00:00.000Z', total: 20000, status: 'placed', decision: { verdict: 'PAY' as const } },
    ];
    expect(isUnattended(mixed[0]!)).toBe(true);
    expect(isUnattended(mixed[1]!)).toBe(false);
    expect(isUnattended(mixed[2]!)).toBe(false);
    expect(capSpend(mixed, now)).toEqual({ spendToday: 30000, spendThisMonth: 30000 + 112300 + 50000 });
  });

  it('counts pending payments but not failed, cancelled or refunded orders', () => {
    expect(countsAsSpend({ status: 'PENDING_PAYMENT' })).toBe(true);
    expect(countsAsSpend({ status: 'REFUND-INITIATED' })).toBe(false);
    expect(countsAsSpend({ status: 'Cancelled' })).toBe(false);
  });

  it('rejects float money in ledger rows', () => {
    expect(() =>
      spendToday([{ placedAt: '2026-11-01T06:30:00.000Z', total: 1.5, status: 'placed' }], '2026-11-01T06:30:00.000Z'),
    ).toThrow();
  });
});
