/**
 * Hostile review: can the gate be made to say PAY on a ₹1,123 cart, or can caps be beaten by concurrency?
 * Tests assert the SECURE behaviour. A red test here is a working exploit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { PolicyBlock, PolicyHold } from '../src/core/errors.js';
import { lineHash } from '../src/core/hash.js';
import type { Approval, CartLine, Household, Member, Place, Quote } from '../src/core/types.js';
import { contextBuilder } from '../src/policy/context.js';
import { placeWithGate, type DecisionRecorder, type GateRecord, type PlacedRecord } from '../src/policy/gate.js';
import type { SpendRow } from '../src/policy/spend.js';
import { StubSupplier } from '../src/suppliers/stub/index.js';
import { NOW, adder, household, owner, placeNamed } from './fixtures/context.js';

const asked = (variantId: string, quantity: number): CartLine => ({ variantId, quantity, reason: { kind: 'asked' } });
const CART_1123 = [asked('v-milk', 2), asked('v-rice', 1), asked('v-chicken', 2), asked('v-onion-1kg', 4)];

class Rec implements DecisionRecorder {
  decisions: GateRecord[] = [];
  placed: PlacedRecord[] = [];
  constructor(
    private readonly ledger: SpendRow[],
    private readonly approvals: Approval[],
  ) {}
  recordDecision(r: GateRecord) {
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
    const a = this.approvals.find((x) => x.id === r.consumeApprovalId);
    if (a) a.consumedAt = r.order.placedAt;
  }
}

let h: Household;
let home: Place;
let supplier: StubSupplier;
let ledger: SpendRow[];
let approvals: Approval[];
let rec: Rec;

beforeEach(() => {
  h = household();
  home = placeNamed(h, 'home');
  supplier = new StubSupplier({ now: () => NOW });
  ledger = [];
  approvals = [];
  rec = new Rec(ledger, approvals);
});

let seq = 0;
function ap(hash: string, by: Member, extra: Partial<Approval> = {}): Approval {
  const a: Approval = {
    id: `ap_r${++seq}`,
    quoteHash: hash,
    memberId: by.id,
    createdAt: NOW,
    expiresAt: new Date(Date.parse(NOW) + 30 * 60_000).toISOString(),
    ...extra,
  };
  approvals.push(a);
  return a;
}

function gate(quote: Quote, aps: Approval[], who: Member = owner(h), place: Place = home, now = NOW) {
  return placeWithGate({
    supplier,
    payment: { kind: 'cod' },
    recorder: rec,
    ctxBuilder: contextBuilder({
      household: h,
      place,
      quote,
      approvals: aps,
      requestingMember: who,
      ledger,
      quantityHistory: {},
      now,
    }),
  });
}

const verdictOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'PAY';
  } catch (e) {
    if (e instanceof PolicyHold) return 'HOLD';
    if (e instanceof PolicyBlock) return 'BLOCK';
    throw e;
  }
};

describe('attempt 2: PAY on ₹1,123 without a proper approval', () => {
  it('2a no approval → HOLD', async () => {
    const q = await supplier.quote(CART_1123, home);
    expect(q.total).toBe(112300);
    expect(await verdictOf(gate(q, []))).toBe('HOLD');
    expect(supplier.placeCalls).toBe(0);
  });

  it("2b an adder's approval → HOLD", async () => {
    const q = await supplier.quote(CART_1123, home);
    expect(await verdictOf(gate(q, [ap(q.hash, adder(h))]))).toBe('HOLD');
    expect(supplier.placeCalls).toBe(0);
  });

  it("2c an approval on another quote's hash → HOLD", async () => {
    const other = await supplier.quote([asked('v-milk', 1)], home);
    const q = await supplier.quote(CART_1123, home);
    expect(await verdictOf(gate(q, [ap(other.hash, owner(h))]))).toBe('HOLD');
    expect(supplier.placeCalls).toBe(0);
  });

  it('2d an expired approval → HOLD; a future-dated (createdAt > now) one too', async () => {
    const q = await supplier.quote(CART_1123, home);
    const expired = ap(q.hash, owner(h), {
      createdAt: '2026-10-12T13:00:00.000Z',
      expiresAt: '2026-10-12T13:30:00.000Z',
    });
    expect(await verdictOf(gate(q, [expired]))).toBe('HOLD');
    const future = ap(q.hash, owner(h), {
      createdAt: '2026-10-12T15:00:00.000Z',
      expiresAt: '2026-10-12T15:30:00.000Z',
    });
    expect(await verdictOf(gate(q, [future]))).toBe('HOLD');
    // Exactly at expiry is expired.
    const edge = ap(q.hash, owner(h), { expiresAt: NOW, createdAt: '2026-10-12T13:30:00.000Z' });
    expect(await verdictOf(gate(q, [edge]))).toBe('HOLD');
    expect(supplier.placeCalls).toBe(0);
  });

  it('2e a consumed approval reused → HOLD (even when a careless builder passes it)', async () => {
    const q = await supplier.quote(CART_1123, home);
    const a = ap(q.hash, owner(h));
    expect(await verdictOf(gate(q, [a]))).toBe('PAY');
    expect(a.consumedAt).toBeDefined();
    const again = await supplier.quote(CART_1123, home);
    expect(again.hash).toBe(q.hash); // same cart, same hash
    expect(await verdictOf(gate(again, [a]))).toBe('HOLD');
    expect(supplier.placeCalls).toBe(1);
  });

  it('2f an approval created before the cart drifted → BLOCK (quote_mismatch), then HOLD on the re-quote', async () => {
    const q = await supplier.quote(CART_1123, home);
    const a = ap(q.hash, owner(h));
    supplier.addOutsideSession('v-milk', 1);
    expect(await verdictOf(gate(q, [a]))).toBe('BLOCK');
    const requote = await supplier.readCart(home);
    expect(await verdictOf(gate(requote, [a]))).toBe('HOLD');
    // A price drift that keeps the lines identical also changes the hash.
    supplier.setDrift(null);
    const q2 = await supplier.quote(CART_1123, home);
    const a2 = ap(q2.hash, owner(h));
    supplier.setPrice('v-chicken', 26100);
    expect(await verdictOf(gate(q2, [a2]))).toBe('BLOCK');
    expect(supplier.placeCalls).toBe(0);
  });

  it('2g a line-bound approval with no maxTotal → HOLD', async () => {
    const q = await supplier.quote(CART_1123, home);
    const a = ap('x', owner(h), { conditions: { lineHash: lineHash(q.lines) } });
    expect(await verdictOf(gate(q, [a]))).toBe('HOLD');
    expect(supplier.placeCalls).toBe(0);
  });

  it('2h a tampered quote total (model-side) cannot reach the gate: a self-consistent forged quote is BLOCKed by the live cart', async () => {
    const q = await supplier.quote(CART_1123, home);
    // Forge: same hash, lower total (as if a model edited it)
    const forged: Quote = { ...q, total: 41200 };
    expect(await verdictOf(gate(forged, []))).toBe('BLOCK');
    expect(supplier.placeCalls).toBe(0);
  });

  /**
   * FAIL. A scheduled (line-bound) owner approval binds only to `variantId:qty`. It does not bind the place, the
   * supplier, or the requester. An approval meant for "home's morning order" pays the same lines to the UNTRUSTED
   * hospital address, requested by an ADDER — both HOLD reasons are lifted by an approval the owner never gave for
   * that place. engine.ts:217-219 (boundToThisQuote) checks only lineHash for line-bound approvals.
   */
  it('2i FAIL: a scheduled approval for home pays the same lines to an untrusted place on an adder request', async () => {
    const homeQuote = await supplier.quote(CART_1123, home);
    const scheduled = ap('unused', owner(h), {
      expiresAt: '2026-10-19T14:00:00.000Z',
      conditions: { lineHash: lineHash(homeQuote.lines), maxTotal: 115000, inStock: true },
    });
    const hospital = placeNamed(h, 'hospital');
    expect(hospital.trusted).toBe(false);
    const hospitalQuote = await supplier.quote(CART_1123, hospital);
    expect(hospitalQuote.hash).not.toBe(homeQuote.hash);
    const verdict = await verdictOf(gate(hospitalQuote, [scheduled], adder(h), hospital));
    expect(verdict, 'owner approved home, not hospital, and not on behalf of an adder').toBe('HOLD');
    expect(supplier.placeCalls).toBe(0);
  });
});

describe('attempt 5: spend caps under concurrency', () => {
  /**
   * FAIL. ₹800 of unattended orders today. Two ₹412 carts on two suppliers are gated concurrently. Each gate reads
   * spendToday = ₹800 before either order is recorded, so both PAY: ₹1,624 unattended today > ₹1,500 cap.
   * There is no lock or reservation between context build (gate.ts:95) and recordPlaced (gate.ts:131).
   */
  it('5a FAIL: two concurrent ₹412 orders exceed the ₹1,500 daily unattended cap', async () => {
    const zepto = new StubSupplier({ id: 'zepto', now: () => NOW });
    const homeZ: Place = { ...home, supplierAddressIds: { ...home.supplierAddressIds, zepto: 'z-home' } };
    ledger.push({ placedAt: '2026-10-12T05:00:00.000Z', total: 80000, status: 'placed', decision: { verdict: 'PAY' } });
    const CART_412 = [asked('v-milk', 1), asked('v-rice', 1), asked('v-onion-1kg', 2)];
    const q1 = await supplier.quote(CART_412, homeZ);
    const q2 = await zepto.quote(CART_412, homeZ);
    expect(q1.total).toBe(41200);
    expect(q2.total).toBe(41200);

    const run = (s: StubSupplier, q: Quote) =>
      verdictOf(
        placeWithGate({
          supplier: s,
          payment: { kind: 'cod' },
          recorder: rec,
          ctxBuilder: contextBuilder({
            household: h,
            place: homeZ,
            quote: q,
            approvals: [],
            requestingMember: owner(h),
            // The live ledger array: the gate reads it only after its own readCart, so this is the best case.
            ledger,
            quantityHistory: {},
            now: NOW,
          }),
        }),
      );
    const [v1, v2] = await Promise.all([run(supplier, q1), run(zepto, q2)]);
    const unattendedToday = ledger
      .filter((r) => r.decision?.verdict === 'PAY' && !r.decision.approvalId)
      .reduce((s, r) => s + r.total, 0);
    // Fix (gate lock): the runs are serialised per household and the second re-reads spend inside the lock, so it
    // sees the first order and is HELD on daily_cap. (Before the fix both said PAY; that line asserted the exploit.)
    expect([v1, v2].sort()).toEqual(['HOLD', 'PAY']);
    expect(unattendedToday, 'daily unattended cap is ₹1,500').toBeLessThanOrEqual(150000);
  });

  it('5b sequential control: the second ₹412 is HELD (daily_cap)', async () => {
    ledger.push({ placedAt: '2026-10-12T05:00:00.000Z', total: 80000, status: 'placed', decision: { verdict: 'PAY' } });
    const CART_412 = [asked('v-milk', 1), asked('v-rice', 1), asked('v-onion-1kg', 2)];
    expect(await verdictOf(gate(await supplier.quote(CART_412, home), []))).toBe('PAY');
    expect(await verdictOf(gate(await supplier.quote(CART_412, home), []))).toBe('HOLD');
  });
});

describe('attempt 1/6: static checks', () => {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(root);

  it('1 nothing outside the gate calls place(), by name, by index, by destructure, or raw checkout', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(join('policy', 'gate.ts'))) continue;
      const src = readFileSync(f, 'utf8');
      if (
        /\.place\s*\(|\[\s*['"`]place['"`]\s*\]|\{\s*[^}]*\bplace\b[^}]*\}\s*=\s*\w*[Ss]upplier|\.call\(\s*['"`](checkout|confirm_order)['"`]/.test(
          src,
        )
      ) {
        // The Instamart adapter's own place() issues checkout; that is the implementation, not a bypass.
        if (f.endsWith(join('instamart', 'adapter.ts'))) continue;
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  /** Recorded, not failing: these are on the parse path (supplier rupees → paise), not the gate's arithmetic. */
  it('6 float arithmetic on amounts is confined to the Instamart toPaise fallback and ledger fee estimates', () => {
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((l, i) => {
          if (/(\*\s*100\b|\/\s*100\b|parseFloat|toFixed)/.test(l) && !/^\s*(\*|\/\/)/.test(l)) {
            hits.push(`${f.slice(root.length + 1)}:${i + 1}`);
          }
        });
    }
    expect(hits.sort()).toEqual(
      [
        'core/money.ts:14', // rupees(): integer * 100
        'core/money.ts:32', // parseRupees(): integer * 100 + integer
        'core/money.ts:60', // formatINR(): display only
        'core/types.ts:119', // a comment string ("10.4/100 ml")
        // (fix 6b) the Instamart toPaise float fallbacks (Math.round(v * 100)) are gone: parseRupeesRounded is
        // string decomposition only.
      ].sort(),
    );
  });
});
