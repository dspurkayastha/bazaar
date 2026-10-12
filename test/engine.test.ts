import { describe, expect, it } from 'vitest';
import { decide } from '../src/policy/engine.js';
import {
  adder,
  approval,
  ctx,
  groceryCart1123,
  groceryCart412,
  household,
  line,
  makeQuote,
  owner,
  placeNamed,
} from './fixtures/context.js';

const rules = (d: { reasons: { rule: string }[] }) => d.reasons.map((r) => r.rule);

describe('policy engine — CONTRACTS.md benchmark cases', () => {
  const h = household();
  const home = placeNamed(h, 'home');

  it('₹1,123 grocery cart, no approval → HOLD (per_order_ceiling)', () => {
    const q = groceryCart1123(home);
    expect(q.total).toBe(112300);
    const d = decide(ctx({ household: h, place: home, quote: q }));
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['per_order_ceiling']);
    expect(d.approvalId).toBeUndefined();
  });

  it('same with owner approval on the hash → PAY', () => {
    const q = groceryCart1123(home);
    const d = decide(ctx({ household: h, place: home, quote: q, approvals: [approval(h, q.hash)] }));
    expect(d.verdict).toBe('PAY');
    expect(d.approvalId).toBe('ap_1');
    // The breach is still on record; the approval lifted it.
    expect(rules(d)).toEqual(['per_order_ceiling']);
  });

  it('same with approval on a different hash → HOLD (approval_mismatch)', () => {
    const q = groceryCart1123(home);
    const d = decide(ctx({ household: h, place: home, quote: q, approvals: [approval(h, 'f'.repeat(64))] }));
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['per_order_ceiling', 'approval_mismatch']);
  });

  it('₹412 grocery cart, trusted place, under caps → PAY, no approval needed', () => {
    const q = groceryCart412(home);
    expect(q.total).toBe(41200);
    const d = decide(ctx({ household: h, place: home, quote: q, spendToday: 50000, spendThisMonth: 300000 }));
    expect(d.verdict).toBe('PAY');
    expect(d.reasons).toEqual([]);
    expect(d.approvalId).toBeUndefined();
  });

  it('₹2,890 cart containing an appliance → BLOCK regardless of approval', () => {
    const q = makeQuote(
      home,
      [line('v-cooker', 'appliances', 200000, 1, 'Pressure cooker'), line('v-rice', 'grocery', 18000, 3, 'Rice')],
      [{ label: 'handling', amount: 35000 }],
    );
    expect(q.total).toBe(289000);
    for (const approvals of [[], [approval(h, q.hash)]]) {
      const d = decide(ctx({ household: h, place: home, quote: q, approvals }));
      expect(d.verdict).toBe('BLOCK');
      expect(rules(d)).toContain('category_blocked');
      expect(d.approvalId).toBeUndefined();
    }
  });

  it('live cart total ≠ quote total → BLOCK (quote_mismatch)', () => {
    const q = groceryCart412(home);
    const live = makeQuote(home, [...q.lines, line('v-chips', 'snacks', 2000)], q.fees);
    const d = decide(ctx({ household: h, place: home, quote: q, liveCart: live, approvals: [approval(h, q.hash)] }));
    expect(d.verdict).toBe('BLOCK');
    expect(rules(d)).toContain('quote_mismatch');
  });

  it('adder requests pay on ₹412 → HOLD (role); owner required', () => {
    const q = groceryCart412(home);
    const d = decide(ctx({ household: h, place: home, quote: q, requestingMember: adder(h) }));
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['role']);
    // An owner's approval on the hash completes it.
    const ok = decide(
      ctx({ household: h, place: home, quote: q, requestingMember: adder(h), approvals: [approval(h, q.hash)] }),
    );
    expect(ok.verdict).toBe('PAY');
  });

  it('untrusted place, ₹412 → HOLD (place_untrusted)', () => {
    const hospital = placeNamed(h, 'hospital');
    const q = groceryCart412(hospital);
    const d = decide(ctx({ household: h, place: hospital, quote: q }));
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['place_untrusted']);
  });

  it('quantity 6 kg onions with 90-day max 2 kg → HOLD (quantity_bound)', () => {
    const q = makeQuote(home, [line('v-onion-1kg', 'produce', 4000, 6, 'Onion 1 kg')]);
    const d = decide(ctx({ household: h, place: home, quote: q, quantityHistory: { 'v-onion-1kg': 2 } }));
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['quantity_bound']);
    // 4 kg (= 2 × 2) is within bound.
    const q4 = makeQuote(home, [line('v-onion-1kg', 'produce', 4000, 4, 'Onion 1 kg')]);
    expect(decide(ctx({ household: h, place: home, quote: q4, quantityHistory: { 'v-onion-1kg': 2 } })).verdict).toBe(
      'PAY',
    );
  });
});

describe('policy engine — other rules', () => {
  const h = household();
  const home = placeNamed(h, 'home');

  it('quantity history resolves profile item keys through supplier hints', () => {
    const hh = household();
    hh.profile.defaults.push({
      key: 'onions',
      aliases: ['pyaj'],
      category: 'produce',
      origin: 'learned',
      supplierHints: { instamart: { spinId: 'v-onion-1kg' } },
    });
    const q = makeQuote(home, [line('v-onion-1kg', 'produce', 4000, 6, 'Onion 1 kg')]);
    const d = decide(ctx({ household: hh, place: placeNamed(hh, 'home'), quote: q, quantityHistory: { onions: 2 } }));
    expect(rules(d)).toEqual(['quantity_bound']);
    expect(d.reasons[0]!.detail).toContain('onions');
  });

  it('daily cap holds when today + this order exceeds ₹1,500', () => {
    const q = groceryCart412(home);
    const d = decide(ctx({ household: h, place: home, quote: q, spendToday: 110000 }));
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['daily_cap']);
    // Exactly at the cap is allowed.
    expect(decide(ctx({ household: h, place: home, quote: q, spendToday: 150000 - 41200 })).verdict).toBe('PAY');
  });

  it('monthly cap holds when this month + this order exceeds ₹8,000', () => {
    const q = groceryCart412(home);
    const d = decide(ctx({ household: h, place: home, quote: q, spendThisMonth: 780000 }));
    expect(rules(d)).toEqual(['monthly_cap']);
    expect(d.verdict).toBe('HOLD');
  });

  it('per-order ceiling is inclusive at ₹500', () => {
    const q = makeQuote(home, [line('v-rice', 'grocery', 50000)]);
    expect(decide(ctx({ household: h, place: home, quote: q })).verdict).toBe('PAY');
    const over = makeQuote(home, [line('v-rice', 'grocery', 50001)]);
    expect(rules(decide(ctx({ household: h, place: home, quote: over })))).toEqual(['per_order_ceiling']);
  });

  it('meat is not an unattended category → HOLD (category_unattended)', () => {
    const q = makeQuote(home, [line('v-chicken', 'meat', 26000, 1, 'Chicken curry cut')]);
    const d = decide(ctx({ household: h, place: home, quote: q }));
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['category_unattended']);
  });

  it('a unit priced over ₹3,000 → BLOCK (unit_price_blocked) even in an allowed category', () => {
    const q = makeQuote(home, [line('v-saffron', 'grocery', 300100, 1, 'Saffron tin')]);
    const d = decide(ctx({ household: h, place: home, quote: q, approvals: [approval(h, q.hash)] }));
    expect(d.verdict).toBe('BLOCK');
    expect(rules(d)).toContain('unit_price_blocked');
  });

  it('expired approval on the right hash → HOLD (approval_expired)', () => {
    const q = groceryCart1123(home);
    const d = decide(
      ctx({
        household: h,
        place: home,
        quote: q,
        approvals: [approval(h, q.hash, { expiresAt: '2026-10-12T13:59:59.000Z' })],
      }),
    );
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['per_order_ceiling', 'approval_expired']);
  });

  it("an adder's approval does not count → HOLD (role)", () => {
    const q = groceryCart1123(home);
    const d = decide(
      ctx({ household: h, place: home, quote: q, approvals: [approval(h, q.hash, { memberId: adder(h).id })] }),
    );
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['per_order_ceiling', 'role']);
  });

  it('scheduled conditions are re-checked at fire time → HOLD (scheduled_conditions)', () => {
    const q = groceryCart1123(home);
    const base = { household: h, place: home, quote: q };
    const maxTotal = decide(ctx({ ...base, approvals: [approval(h, q.hash, { conditions: { maxTotal: 100000 } })] }));
    expect(maxTotal.verdict).toBe('HOLD');
    expect(rules(maxTotal)).toContain('scheduled_conditions');

    const notBefore = decide(
      ctx({ ...base, approvals: [approval(h, q.hash, { conditions: { notBefore: '2026-10-12T18:00:00.000Z' } })] }),
    );
    expect(rules(notBefore)).toContain('scheduled_conditions');

    const oos = { ...q, unavailable: [{ itemKey: 'mint', reason: 'out of stock' }] };
    const inStock = decide(
      ctx({ ...base, quote: oos, liveCart: oos, approvals: [approval(h, q.hash, { conditions: { inStock: true } })] }),
    );
    expect(rules(inStock)).toContain('scheduled_conditions');
    expect(inStock.verdict).toBe('HOLD');

    const met = decide(
      ctx({ ...base, approvals: [approval(h, q.hash, { conditions: { maxTotal: 120000, inStock: true } })] }),
    );
    expect(met.verdict).toBe('PAY');
  });

  it('a conditional approval whose conditions fail holds even an otherwise unattended cart', () => {
    const q = groceryCart412(home);
    const d = decide(
      ctx({
        household: h,
        place: home,
        quote: q,
        approvals: [approval(h, q.hash, { conditions: { maxTotal: 40000 } })],
      }),
    );
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['scheduled_conditions']);
  });

  it('a quote for another place, or a tampered hash, → BLOCK (quote_mismatch)', () => {
    const hospitalQuote = groceryCart412(placeNamed(h, 'hospital'));
    const wrongPlace = decide(ctx({ household: h, place: home, quote: hospitalQuote }));
    expect(wrongPlace.verdict).toBe('BLOCK');
    expect(rules(wrongPlace)).toContain('quote_mismatch');

    const q = groceryCart412(home);
    const forged = { ...q, total: 30000, hash: q.hash };
    const d = decide(ctx({ household: h, place: home, quote: forged, liveCart: forged }));
    expect(d.verdict).toBe('BLOCK');
    expect(rules(d)).toContain('quote_mismatch');
  });

  it('evaluates every rule without short-circuiting', () => {
    const rahuls = placeNamed(h, "rahul's");
    const q = makeQuote(rahuls, [
      line('v-whisky', 'alcohol', 350000, 1, 'Whisky'),
      line('v-chicken', 'meat', 26000, 9, 'Chicken'),
    ]);
    const d = decide(
      ctx({
        household: h,
        place: rahuls,
        quote: q,
        requestingMember: adder(h),
        spendToday: 100000,
        spendThisMonth: 790000,
        quantityHistory: { 'v-chicken': 2 },
        approvals: [approval(h, q.hash)],
      }),
    );
    expect(d.verdict).toBe('BLOCK');
    expect(new Set(rules(d))).toEqual(
      new Set([
        'per_order_ceiling',
        'daily_cap',
        'monthly_cap',
        'category_blocked',
        'unit_price_blocked',
        'category_unattended',
        'quantity_bound',
        'role',
        'place_untrusted',
      ]),
    );
  });

  it('is pure: same input, same output, input untouched', () => {
    const q = groceryCart1123(home);
    const c = ctx({ household: h, place: home, quote: q, approvals: [approval(h, q.hash)] });
    const snapshot = structuredClone(c);
    expect(decide(c)).toEqual(decide(c));
    expect(c).toEqual(snapshot);
    expect(decide(c).evaluatedAt).toBe(c.now);
    expect(owner(h).role).toBe('owner');
  });
});
