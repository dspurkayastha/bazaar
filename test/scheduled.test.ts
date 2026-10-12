/** Engine-level tests for line-bound (scheduled) approvals, per the CONTRACTS.md amendment. */
import { describe, expect, it } from 'vitest';
import { lineHash } from '../src/core/hash.js';
import type { Approval, Quote } from '../src/core/types.js';
import { decide } from '../src/policy/engine.js';
import { approval, ctx, groceryCart1123, household, line, makeQuote, placeNamed } from './fixtures/context.js';

const rules = (d: { reasons: { rule: string }[] }) => d.reasons.map((r) => r.rule);
const h = household();
const home = placeNamed(h, 'home');
const FIRE = '2026-10-13T02:30:00.000Z';

/** Same lines as groceryCart1123, with prices that moved overnight (+₹5 on rice). */
function repriced(q: Quote): Quote {
  return makeQuote(
    home,
    q.lines.map((l) => (l.variantId === 'v-rice' ? line('v-rice', 'grocery', 18500, l.quantity) : l)),
    q.fees,
  );
}

function scheduled(
  q: Quote,
  conditions: Partial<NonNullable<Approval['conditions']>> = {},
  extra: Partial<Approval> = {},
) {
  return approval(h, q.hash, {
    expiresAt: '2026-10-19T14:00:00.000Z',
    conditions: { lineHash: lineHash(q.lines), maxTotal: 120000, inStock: true, ...conditions },
    ...extra,
  });
}

describe('line-bound approvals', () => {
  const approved = groceryCart1123(home);
  const fire = repriced(approved);

  it('match: same lines, new hash, within maxTotal, after notBefore → PAY', () => {
    expect(fire.hash).not.toBe(approved.hash);
    expect(fire.total).toBe(113800);
    const ap = scheduled(approved, { notBefore: '2026-10-13T02:00:00.000Z' });
    const d = decide(ctx({ household: h, place: home, quote: fire, approvals: [ap], now: FIRE }));
    expect(d.verdict).toBe('PAY');
    expect(d.approvalId).toBe(ap.id);
  });

  it('stale lines: a different line set → HOLD (approval_mismatch)', () => {
    const other = makeQuote(home, [...approved.lines.slice(1), line('v-atta', 'grocery', 8000, 2)], approved.fees);
    const d = decide(ctx({ household: h, place: home, quote: other, approvals: [scheduled(approved)], now: FIRE }));
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['per_order_ceiling', 'approval_mismatch']);
  });

  it('over maxTotal → HOLD (scheduled_conditions)', () => {
    const d = decide(
      ctx({
        household: h,
        place: home,
        quote: fire,
        approvals: [scheduled(approved, { maxTotal: 113000 })],
        now: FIRE,
      }),
    );
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['per_order_ceiling', 'scheduled_conditions']);
    expect(d.reasons[1]!.detail).toContain('approved max');
  });

  it('before notBefore → HOLD (scheduled_conditions)', () => {
    const ap = scheduled(approved, { notBefore: '2026-10-13T02:00:00.000Z' });
    const d = decide(ctx({ household: h, place: home, quote: fire, approvals: [ap], now: '2026-10-13T01:59:00.000Z' }));
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toContain('scheduled_conditions');
  });

  it('consumed → HOLD (approval_consumed)', () => {
    const ap = scheduled(approved, {}, { consumedAt: '2026-10-12T15:00:00.000Z' });
    const d = decide(ctx({ household: h, place: home, quote: fire, approvals: [ap], now: FIRE }));
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['per_order_ceiling', 'approval_consumed']);
  });

  it('expired → HOLD (approval_expired)', () => {
    const ap = scheduled(approved, {}, { expiresAt: '2026-10-13T00:00:00.000Z' });
    const d = decide(ctx({ household: h, place: home, quote: fire, approvals: [ap], now: FIRE }));
    expect(rules(d)).toEqual(['per_order_ceiling', 'approval_expired']);
  });

  it('an item out of stock → HOLD, even without inStock set', () => {
    const oos = { ...fire, unavailable: [{ itemKey: 'v-atta', reason: 'out of stock' }] };
    const ap = scheduled(approved, { inStock: undefined });
    const d = decide(ctx({ household: h, place: home, quote: oos, liveCart: oos, approvals: [ap], now: FIRE }));
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toContain('scheduled_conditions');
  });

  it('a line-bound approval without maxTotal is refused', () => {
    const ap = scheduled(approved, { maxTotal: undefined });
    const d = decide(ctx({ household: h, place: home, quote: fire, approvals: [ap], now: FIRE }));
    expect(d.verdict).toBe('HOLD');
    expect(d.reasons.at(-1)!.detail).toContain('no maxTotal');
  });

  it('a hash-bound approval still requires the exact quote hash', () => {
    const ap = approval(h, approved.hash, { expiresAt: '2026-10-19T14:00:00.000Z' });
    const d = decide(ctx({ household: h, place: home, quote: fire, approvals: [ap], now: FIRE }));
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toContain('approval_mismatch');
  });

  it('never lifts a BLOCK', () => {
    const cooker = makeQuote(home, [line('v-cooker', 'appliances', 200000)]);
    const ap = scheduled(cooker, { maxTotal: 300000 });
    expect(decide(ctx({ household: h, place: home, quote: cooker, approvals: [ap], now: FIRE })).verdict).toBe('BLOCK');
  });
});

describe('line itemKey', () => {
  it('quantity bounds join on QuoteLine.itemKey when present', () => {
    const q = makeQuote(home, [{ ...line('v-onion-1kg', 'produce', 4000, 6, 'Onion 1 kg'), itemKey: 'onions' }]);
    const d = decide(ctx({ household: h, place: home, quote: q, quantityHistory: { onions: 2 } }));
    expect(rules(d)).toEqual(['quantity_bound']);
  });
});
