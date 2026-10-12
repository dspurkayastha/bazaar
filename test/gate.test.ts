import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { PolicyBlock, PolicyHold } from '../src/core/errors.js';
import type { Approval, CartLine, Household, Member, Place, Quote } from '../src/core/types.js';
import { lineHash } from '../src/core/hash.js';
import { contextBuilder } from '../src/policy/context.js';
import {
  needsRequote,
  placeWithGate,
  type DecisionRecorder,
  type GateRecord,
  type PlacedRecord,
} from '../src/policy/gate.js';
import type { SpendRow } from '../src/policy/spend.js';
import { StubSupplier } from '../src/suppliers/stub/index.js';
import { NOW, adder, household, owner, placeNamed } from './fixtures/context.js';

const asked = (variantId: string, quantity: number): CartLine => ({ variantId, quantity, reason: { kind: 'asked' } });

/** The ₹1,123 biryani-night cart: ₹1,100 of items + ₹8 handling + ₹15 delivery. */
const CART_1123 = [asked('v-milk', 2), asked('v-rice', 1), asked('v-chicken', 2), asked('v-onion-1kg', 4)];
/** ₹412: ₹380 of items + ₹8 handling + ₹24 delivery. */
const CART_412 = [asked('v-milk', 1), asked('v-rice', 1), asked('v-onion-1kg', 2)];

/** Reference recorder: appends decisions, appends ledger rows, and consumes the approval that was used. */
class MemoryRecorder implements DecisionRecorder {
  decisions: GateRecord[] = [];
  placed: PlacedRecord[] = [];
  fail = false;
  constructor(
    private readonly ledger: SpendRow[],
    private readonly approvals: Approval[],
  ) {}
  recordDecision(r: GateRecord) {
    if (this.fail) throw new Error('ledger unavailable');
    this.decisions.push(r);
  }
  recordPlaced(r: PlacedRecord) {
    this.placed.push(r);
    this.ledger.push({
      placedAt: r.order.placedAt,
      total: r.quote.total,
      status: r.order.status,
      decision: { verdict: r.decision.verdict, ...(r.approvalId ? { approvalId: r.approvalId } : {}) },
    });
    if (r.consumeApprovalId) {
      const a = this.approvals.find((x) => x.id === r.consumeApprovalId);
      if (a) a.consumedAt = r.order.placedAt;
    }
  }
}

let h: Household;
let home: Place;
let supplier: StubSupplier;
let recorder: MemoryRecorder;
let ledger: SpendRow[];
/** Every approval ever issued; the recorder marks used ones consumed in place. */
let store: Approval[];

beforeEach(() => {
  h = household();
  home = placeNamed(h, 'home');
  supplier = new StubSupplier({ now: () => NOW });
  ledger = [];
  store = [];
  recorder = new MemoryRecorder(ledger, store);
});

let apSeq = 0;
function approve(quote: Quote, by: Member = owner(h), extra: Partial<Approval> = {}): Approval {
  const a: Approval = {
    id: `ap_${++apSeq}`,
    quoteHash: quote.hash,
    memberId: by.id,
    createdAt: NOW,
    expiresAt: new Date(Date.parse(NOW) + 30 * 60_000).toISOString(),
    ...extra,
  };
  store.push(a);
  return a;
}

/** A scheduled approval bound to the quote's lines with a ceiling. */
function approveLines(quote: Quote, maxTotal: number, extra: Partial<NonNullable<Approval['conditions']>> = {}) {
  return approve(quote, owner(h), {
    expiresAt: '2026-10-19T14:00:00.000Z',
    conditions: { lineHash: lineHash(quote.lines), maxTotal, inStock: true, ...extra },
  });
}

function gate(
  quote: Quote,
  approvals: Approval[] = [],
  requestingMember: Member = owner(h),
  place: Place = home,
  now: string = NOW,
) {
  return placeWithGate({
    supplier,
    payment: { kind: 'cod' },
    recorder,
    ctxBuilder: contextBuilder({
      household: h,
      place,
      quote,
      approvals,
      requestingMember,
      ledger,
      quantityHistory: {},
      now,
    }),
  });
}

describe('placeWithGate with the stub supplier', () => {
  it('builds the ₹1,123 benchmark cart', async () => {
    const q = await supplier.quote(CART_1123, home);
    expect(q.total).toBe(112300);
    expect((await supplier.readCart(home)).hash).toBe(q.hash);
  });

  it('a ₹1,123 cart cannot be placed without an owner approval on its exact hash', async () => {
    const q = await supplier.quote(CART_1123, home);

    await expect(gate(q)).rejects.toBeInstanceOf(PolicyHold);
    expect(supplier.placeCalls).toBe(0);
    expect(recorder.decisions).toHaveLength(1);
    expect(recorder.decisions[0]!.decision.verdict).toBe('HOLD');
    expect(recorder.decisions[0]!.decision.reasons.map((r) => r.rule)).toContain('per_order_ceiling');

    // An adder's "approval" is not an approval.
    await expect(gate(q, [approve(q, adder(h))])).rejects.toBeInstanceOf(PolicyHold);
    // An approval for some other quote is not an approval.
    const other = { ...q, hash: 'a'.repeat(64) };
    const err = await gate(q, [approve(other)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyHold);
    expect((err as PolicyHold).decision.reasons.map((r) => r.rule)).toContain('approval_mismatch');
    expect(supplier.placeCalls).toBe(0);

    // The owner's approval on the exact hash lets it through, once.
    const ap = approve(q);
    const result = await gate(q, [ap]);
    expect(result.decision.verdict).toBe('PAY');
    expect(result.decision.approvalId).toBe(ap.id);
    expect(supplier.placeCalls).toBe(1);
    expect(supplier.placed[0]!.quote.hash).toBe(q.hash);
    expect(recorder.placed).toHaveLength(1);
    expect(recorder.decisions.map((d) => d.decision.verdict)).toEqual(['HOLD', 'HOLD', 'HOLD', 'PAY']);
  });

  it('an approval on a stale hash fails after the cart drifts', async () => {
    const q = await supplier.quote(CART_1123, home);
    const ap = approve(q);

    // Price of milk changes on the supplier side after the owner approved.
    supplier.setPrice('v-milk', 12500);
    const blocked = await gate(q, [ap]).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(PolicyBlock);
    expect((blocked as PolicyBlock).decision.reasons.map((r) => r.rule)).toContain('quote_mismatch');
    expect(needsRequote(blocked)).toBe(true);
    expect(supplier.placeCalls).toBe(0);

    // Re-quote: a new hash. The old approval does not carry over.
    const q2 = await supplier.quote(CART_1123, home);
    expect(q2.hash).not.toBe(q.hash);
    expect(q2.total).toBe(113300);
    const held = await gate(q2, [ap]).catch((e: unknown) => e);
    expect(held).toBeInstanceOf(PolicyHold);
    expect((held as PolicyHold).decision.reasons.map((r) => r.rule)).toContain('approval_mismatch');
    expect(supplier.placeCalls).toBe(0);

    // A fresh approval on the new hash pays.
    const ok = await gate(q2, [ap, approve(q2)]);
    expect(ok.decision.verdict).toBe('PAY');
    expect(supplier.placeCalls).toBe(1);
  });

  it('an item added to the cart outside the session blocks an approved quote', async () => {
    const q = await supplier.quote(CART_1123, home);
    supplier.addOutsideSession('v-onion-1kg', 1);
    const err = await gate(q, [approve(q)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyBlock);
    expect(needsRequote(err)).toBe(true);
    expect(supplier.placeCalls).toBe(0);
  });

  it('configurable drift on read also blocks, even when the total happens to match', async () => {
    const q = await supplier.quote(CART_412, home);
    // Milk (₹120) swapped for 3 more kg of onions (₹120): same ₹412 total, different cart.
    supplier.setDrift((lines) =>
      lines
        .filter((l) => l.variantId !== 'v-milk')
        .map((l) => (l.variantId === 'v-onion-1kg' ? { ...l, quantity: l.quantity + 3 } : l)),
    );
    const drifted = await supplier.readCart(home);
    expect(drifted.total).toBe(q.total);
    expect(drifted.hash).not.toBe(q.hash);
    const err = await gate(q).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyBlock);
    expect(needsRequote(err)).toBe(true);
    supplier.setDrift(null);
    await expect(gate(q)).resolves.toMatchObject({ decision: { verdict: 'PAY' } });
  });

  it('a ₹412 cart at home pays unattended with no approval', async () => {
    const q = await supplier.quote(CART_412, home);
    expect(q.total).toBe(41200);
    const r = await gate(q);
    expect(r.decision).toMatchObject({ verdict: 'PAY', reasons: [] });
    expect(r.order.status).toBe('placed');
  });

  it('the daily cap counts unattended orders already placed today (IST)', async () => {
    ledger.push({
      placedAt: '2026-10-12T03:00:00.000Z',
      total: 120000,
      status: 'DELIVERED',
      decision: { verdict: 'PAY' },
    });
    const q = await supplier.quote(CART_412, home);
    const err = await gate(q).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyHold);
    expect((err as PolicyHold).decision.reasons.map((r) => r.rule)).toEqual(['daily_cap']);
  });

  it('approved and in-app orders do not count toward the daily cap, but do toward the monthly cap', async () => {
    ledger.push(
      // Approved by the owner earlier today
      {
        placedAt: '2026-10-12T03:00:00.000Z',
        total: 120000,
        status: 'DELIVERED',
        decision: { verdict: 'PAY', approvalId: 'ap_x' },
      },
      // Placed by a human in the Swiggy app (ingested history, no gate decision)
      { placedAt: '2026-10-12T05:00:00.000Z', total: 100000, status: 'DELIVERED' },
    );
    const q = await supplier.quote(CART_412, home);
    await expect(gate(q)).resolves.toMatchObject({ decision: { verdict: 'PAY' } });

    // Push the month close to ₹8,000 with approved orders: the monthly cap now holds.
    ledger.push({ placedAt: '2026-10-02T05:00:00.000Z', total: 560000, status: 'DELIVERED' });
    const q2 = await supplier.quote(CART_412, home);
    const err = await gate(q2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyHold);
    expect((err as PolicyHold).decision.reasons.map((r) => r.rule)).toEqual(['monthly_cap']);
  });

  it('the decision record says whether an approval was used', async () => {
    const small = await supplier.quote(CART_412, home);
    await gate(small);
    const big = await supplier.quote(CART_1123, home);
    const ap = approve(big);
    await expect(gate(big)).rejects.toBeInstanceOf(PolicyHold);
    await gate(big, [ap]);
    expect(recorder.decisions.map((d) => [d.decision.verdict, d.approvalUsed, d.unattended, d.approvalId])).toEqual([
      ['PAY', false, true, undefined],
      ['HOLD', false, false, undefined],
      ['PAY', true, false, ap.id],
    ]);
    expect(recorder.placed.map((p) => p.consumeApprovalId)).toEqual([undefined, ap.id]);
    // Ledger: the unattended order counts to today's cap, the approved one does not.
    expect(ledger.map((r) => r.decision)).toEqual([{ verdict: 'PAY' }, { verdict: 'PAY', approvalId: ap.id }]);
  });

  it('an approval is single-use: once consumed it cannot pay again', async () => {
    const q = await supplier.quote(CART_1123, home);
    const ap = approve(q);
    await gate(q, [ap]);
    expect(ap.consumedAt).toBe(NOW);
    expect(supplier.placeCalls).toBe(1);

    // Same cart again (same hash) with the same approval → held.
    const again = await supplier.quote(CART_1123, home);
    expect(again.hash).toBe(q.hash);
    await expect(gate(again, [ap])).rejects.toBeInstanceOf(PolicyHold);
    expect(supplier.placeCalls).toBe(1);
  });

  it('an appliance blocks even with an owner approval', async () => {
    const q = await supplier.quote([asked('v-cooker', 1), asked('v-milk', 1)], home);
    const err = await gate(q, [approve(q)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyBlock);
    expect((err as PolicyBlock).decision.reasons.map((r) => r.rule)).toContain('category_blocked');
    expect(supplier.placeCalls).toBe(0);
  });

  it('fails closed when the decision cannot be recorded', async () => {
    const q = await supplier.quote(CART_412, home);
    recorder.fail = true;
    await expect(gate(q)).rejects.toThrow('ledger unavailable');
    expect(supplier.placeCalls).toBe(0);
  });

  it('a quote for one place cannot be paid as another place', async () => {
    const q = await supplier.quote(CART_412, home);
    const hospital = placeNamed(h, 'hospital');
    const err = await gate(q, [approve(q)], owner(h), hospital).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyBlock);
    expect(supplier.placeCalls).toBe(0);
  });
});

describe('placeWithGate — scheduled (line-bound) approvals', () => {
  const FIRE = '2026-10-13T02:30:00.000Z'; // next morning, 08:00 IST

  it('pays a fire-time re-quote with the same lines within maxTotal, once', async () => {
    const q = await supplier.quote(CART_1123, home);
    const ap = approveLines(q, 115000, { notBefore: '2026-10-13T02:00:00.000Z' });
    // Overnight the price of milk rises by ₹5: new quote hash, same lines.
    supplier.setPrice('v-milk', 12500);
    const fire = await supplier.quote(CART_1123, home);
    expect(fire.hash).not.toBe(q.hash);
    expect(fire.total).toBe(113300);

    const r = await gate(fire, [ap], owner(h), home, FIRE);
    expect(r.decision).toMatchObject({ verdict: 'PAY', approvalId: ap.id });
    expect(ap.consumedAt).toBe(NOW); // stub's order time

    // Consumed: next week's fire with the same approval is held.
    const nextWeek = await supplier.quote(CART_1123, home);
    const err = await gate(nextWeek, [ap], owner(h), home, FIRE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyHold);
    expect(supplier.placeCalls).toBe(1);
  });

  it('holds when the lines changed (stale line hash)', async () => {
    const q = await supplier.quote(CART_1123, home);
    const ap = approveLines(q, 200000);
    const changed = await supplier.quote([...CART_1123.slice(0, 3), asked('v-onion-1kg', 5)], home);
    const err = await gate(changed, [ap], owner(h), home, FIRE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyHold);
    expect((err as PolicyHold).decision.reasons.map((r) => r.rule)).toContain('approval_mismatch');
    expect(supplier.placeCalls).toBe(0);
  });

  it('holds when the fire-time total is over maxTotal', async () => {
    const q = await supplier.quote(CART_1123, home);
    const ap = approveLines(q, 113000);
    supplier.setPrice('v-chicken', 28000);
    const fire = await supplier.quote(CART_1123, home);
    const err = await gate(fire, [ap], owner(h), home, FIRE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyHold);
    expect((err as PolicyHold).decision.reasons.map((r) => r.rule)).toContain('scheduled_conditions');
    expect(supplier.placeCalls).toBe(0);
  });

  it('holds when fired before notBefore', async () => {
    const q = await supplier.quote(CART_1123, home);
    const ap = approveLines(q, 120000, { notBefore: '2026-10-13T02:00:00.000Z' });
    const err = await gate(q, [ap], owner(h), home, '2026-10-13T01:00:00.000Z').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyHold);
    expect((err as PolicyHold).decision.reasons.map((r) => r.rule)).toContain('scheduled_conditions');
  });

  it('holds when an item is out of stock at fire time (never substitutes)', async () => {
    const q = await supplier.quote(CART_1123, home);
    const ap = approveLines(q, 120000);
    supplier.setInStock('v-chicken', false);
    const fire = await supplier.quote(CART_1123, home);
    expect(fire.unavailable).toHaveLength(1);
    const err = await gate(fire, [ap], owner(h), home, FIRE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyHold);
    expect(supplier.placeCalls).toBe(0);
  });

  it('the gate drops consumed approvals even if the builder passes them', async () => {
    const q = await supplier.quote(CART_1123, home);
    const ap = approveLines(q, 120000);
    ap.consumedAt = '2026-10-12T10:00:00.000Z';
    // A careless builder that does not filter consumed approvals.
    const inputs = { household: h, place: home, quote: q, requestingMember: owner(h), ledger, quantityHistory: {} };
    const err = await placeWithGate({
      supplier,
      payment: { kind: 'cod' },
      recorder,
      ctxBuilder: {
        place: home,
        build: (liveCart) => ({
          ...inputs,
          liveCart,
          approvals: [ap],
          spendToday: 0,
          spendThisMonth: 0,
          now: FIRE,
        }),
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyHold);
    // Filtered by the gate before the engine ran, so the engine never saw it.
    expect((err as PolicyHold).decision.reasons.map((r) => r.rule)).not.toContain('approval_consumed');
    expect(supplier.placeCalls).toBe(0);
  });
});

describe('architecture', () => {
  it('only src/policy/gate.ts calls Supplier.place', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith(join('policy', 'gate.ts'))) {
          const src = readFileSync(p, 'utf8');
          // `.place(` as a call; `async place(` method definitions in supplier implementations are fine.
          if (/\.place\s*\(/.test(src)) offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
