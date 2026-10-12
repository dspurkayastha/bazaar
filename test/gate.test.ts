import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { PolicyBlock, PolicyHold } from '../src/core/errors.js';
import type { Approval, CartLine, Household, Member, Place, Quote } from '../src/core/types.js';
import { needsRequote, placeWithGate, type DecisionRecorder, type GateRecord } from '../src/policy/gate.js';
import { spendThisMonth, spendToday, type SpendRow } from '../src/policy/spend.js';
import { StubSupplier } from '../src/suppliers/stub/index.js';
import { NOW, adder, household, owner, placeNamed } from './fixtures/context.js';

const asked = (variantId: string, quantity: number): CartLine => ({ variantId, quantity, reason: { kind: 'asked' } });

/** The ₹1,123 biryani-night cart: ₹1,100 of items + ₹8 handling + ₹15 delivery. */
const CART_1123 = [asked('v-milk', 2), asked('v-rice', 1), asked('v-chicken', 2), asked('v-onion-1kg', 4)];
/** ₹412: ₹380 of items + ₹8 handling + ₹24 delivery. */
const CART_412 = [asked('v-milk', 1), asked('v-rice', 1), asked('v-onion-1kg', 2)];

class MemoryRecorder implements DecisionRecorder {
  decisions: GateRecord[] = [];
  placed: (GateRecord & { order: unknown })[] = [];
  fail = false;
  recordDecision(r: GateRecord) {
    if (this.fail) throw new Error('ledger unavailable');
    this.decisions.push(r);
  }
  recordPlaced(r: GateRecord & { order: unknown }) {
    this.placed.push(r);
  }
}

let h: Household;
let home: Place;
let supplier: StubSupplier;
let recorder: MemoryRecorder;
let ledger: SpendRow[];

beforeEach(() => {
  h = household();
  home = placeNamed(h, 'home');
  supplier = new StubSupplier({ now: () => NOW });
  recorder = new MemoryRecorder();
  ledger = [];
});

function approve(quote: Quote, by: Member = owner(h)): Approval {
  return {
    id: `ap_${quote.hash.slice(0, 6)}`,
    quoteHash: quote.hash,
    memberId: by.id,
    createdAt: NOW,
    expiresAt: new Date(Date.parse(NOW) + 30 * 60_000).toISOString(),
  };
}

function gate(quote: Quote, approvals: Approval[] = [], requestingMember: Member = owner(h), place: Place = home) {
  return placeWithGate({
    supplier,
    payment: { kind: 'cod' },
    recorder,
    ctxBuilder: {
      place,
      build: (liveCart) => ({
        household: h,
        place,
        quote,
        liveCart,
        approvals,
        requestingMember,
        spendToday: spendToday(ledger, NOW),
        spendThisMonth: spendThisMonth(ledger, NOW),
        quantityHistory: {},
        now: NOW,
      }),
    },
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

  it('the daily cap counts what the ledger already spent today (IST)', async () => {
    ledger.push({ placedAt: '2026-10-12T03:00:00.000Z', total: 120000, status: 'DELIVERED' });
    const q = await supplier.quote(CART_412, home);
    const err = await gate(q).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyHold);
    expect((err as PolicyHold).decision.reasons.map((r) => r.rule)).toEqual(['daily_cap']);
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
