/**
 * Hostile review of the Instamart adapter's place() and its interaction with the gate.
 * Tests assert the SECURE behaviour; a red test is a working exploit or an unmet guarantee.
 */
import { describe, expect, it } from 'vitest';
import { PolicyBlock, PolicyHold, QuoteMismatch, SupplierError } from '../src/core/errors.js';
import type { Approval, CartLine, Household, Place } from '../src/core/types.js';
import { contextBuilder } from '../src/policy/context.js';
import { placeWithGate, type DecisionRecorder } from '../src/policy/gate.js';
import { InstamartSupplier, toPaise } from '../src/suppliers/instamart/adapter.js';
import { household, owner, placeNamed } from './fixtures/context.js';
import { fakeTool, fixture, HOME, NOW } from './fixtures/instamart/harness.js';
import type { FakeTool } from './fixtures/instamart/harness.js';

function tool(extra: Record<string, unknown> = {}): FakeTool {
  return fakeTool({
    update_cart: fixture('update_cart'),
    get_cart: fixture('get_cart'),
    clear_cart: { success: true },
    checkout: fixture('checkout_cod'),
    check_payment_status: fixture('check_payment_status_success'),
    confirm_order: fixture('confirm_order'),
    get_orders: fixture('get_orders'),
    ...extra,
  });
}
const sup = (t: FakeTool) => new InstamartSupplier({ callTool: t.callTool, now: () => NOW });
const LINES: CartLine[] = [
  { variantId: 'SPIN-0001', skuId: 'SKU-0001', quantity: 2, reason: { kind: 'asked', itemKey: 'milk' } },
  { variantId: 'SPIN-0101', skuId: 'SKU-0101', quantity: 1, reason: { kind: 'default', itemKey: 'onion' } },
];

describe('attempt 7: Instamart place()', () => {
  it('7a reads the cart and compares the hash BEFORE checkout; drift → no checkout', async () => {
    const t = tool();
    const s = sup(t);
    const q = await s.quote(LINES, HOME);
    t.calls.length = 0;
    await s.place(q, { kind: 'cod' });
    expect(t.calls.map((c) => c.name)).toEqual(['get_cart', 'checkout']);

    // Same lines, a fee changed server-side (to-pay up by ₹10): refused before checkout.
    const drift = fixture<{ cart: { bill: { lines: { label: string; value: unknown }[] } } }>('get_cart');
    drift.cart.bill.lines = drift.cart.bill.lines.map((r) =>
      r.label === 'Delivery Fee' ? { ...r, value: '₹35' } : r.label === 'To Pay' ? { ...r, value: '₹240.50' } : r,
    );
    t.set('get_cart', drift);
    t.calls.length = 0;
    await expect(s.place(q, { kind: 'cod' })).rejects.toBeInstanceOf(QuoteMismatch);
    expect(t.count('checkout')).toBe(0);
  });

  it('7b checkout is never retried, even on a transport error', async () => {
    const t = tool({
      checkout: () => {
        throw new Error('socket hang up');
      },
    });
    const s = sup(t);
    const q = await s.quote(LINES, HOME);
    await expect(s.place(q, { kind: 'cod' })).rejects.toThrow();
    expect(t.count('checkout')).toBe(1);
  });

  it('7c confirmDuplicate is never set, for any payment kind, including after the duplicate rejection', async () => {
    for (const pay of [{ kind: 'cod' }, { kind: 'wallet' }, { kind: 'upi', intentApp: 'x' }] as const) {
      const t = tool({ checkout: fixture('checkout_duplicate_error') });
      const s = sup(t);
      const q = await s.quote(LINES, HOME);
      await expect(s.place(q, pay)).rejects.toBeInstanceOf(SupplierError);
      expect(t.count('checkout')).toBe(1);
      expect(t.calls.some((c) => 'confirmDuplicate' in c.args)).toBe(false);
    }
  });

  /**
   * PLAUSIBLE. get_cart carries the server cart's addressId, but parseCart ignores it and readCart stamps the
   * place's address id onto whatever cart is there (adapter.ts:528-531). A cart priced for another address (changed
   * in the app) hashes as if it were home's. Checkout then sends home's addressId and the server may re-price.
   */
  it("7d PLAUSIBLE: readCart does not verify the server cart's addressId", async () => {
    const other = fixture<{ cart: { addressId: string } }>('get_cart');
    other.cart.addressId = 'ADDR-HOSPITAL-MASKED';
    const s = sup(tool({ get_cart: other }));
    const read = await s.readCart(HOME).catch((e: unknown) => e);
    expect(
      read instanceof Error ||
        (read as { supplierAddressId: string }).supplierAddressId !== HOME.supplierAddressIds.instamart,
    ).toBe(true);
  });

  /**
   * FAIL (Bazaar-side; Swiggy-side rescues it). Two /approve calls for the same held quote arrive together (double
   * tap, or WhatsApp + app). Each mints its own approval, each gate reads the live cart, each says PAY, and each calls
   * place(): both get_cart reads happen before either checkout lands, so two checkouts go out. Nothing in Bazaar
   * serialises gate evaluations or makes place() idempotent per quote hash; only the server's cart-clear / duplicate
   * check stops the second charge.
   */
  it('5c FAIL: two concurrent approvals of one quote send two checkouts', async () => {
    let cartFull = true;
    const t = tool({
      get_cart: () => (cartFull ? fixture('get_cart') : fixture('get_cart_empty')),
      checkout: () => {
        if (!cartFull) return { isError: true, content: [{ type: 'text', text: 'cart is empty' }] };
        cartFull = false;
        return fixture('checkout_cod');
      },
    });
    const s = sup(t);
    const h: Household = household();
    const home: Place = { ...placeNamed(h, 'home'), supplierAddressIds: HOME.supplierAddressIds, id: HOME.id };
    h.places = h.places.map((p) => (p.nickname === 'home' ? home : p));
    const q = await s.quote(LINES, { ...home });
    const recorder: DecisionRecorder = { recordDecision: () => undefined, recordPlaced: () => undefined };
    const mk = (id: string): Approval => ({
      id,
      quoteHash: q.hash,
      memberId: owner(h).id,
      createdAt: NOW,
      expiresAt: '2026-10-12T14:30:00.000Z',
    });
    const one = (a: Approval) =>
      placeWithGate({
        supplier: s,
        payment: { kind: 'cod' },
        recorder,
        ctxBuilder: contextBuilder({
          household: h,
          place: home,
          quote: q,
          approvals: [a],
          requestingMember: owner(h),
          ledger: [],
          quantityHistory: {},
          now: NOW,
        }),
      }).then(
        () => 'PAY',
        (e: unknown) => (e instanceof PolicyHold ? 'HOLD' : e instanceof PolicyBlock ? 'BLOCK' : 'ERROR'),
      );
    const outcomes = await Promise.all([one(mk('ap_x')), one(mk('ap_y'))]);
    expect(outcomes.filter((o) => o === 'PAY')).toHaveLength(1);
    expect(t.count('checkout'), 'Bazaar should send at most one checkout per quote').toBe(1);
  });
});

describe('attempt 6: money arithmetic', () => {
  /** Minor: toPaise claims "round half up" but falls back to Math.round(v * 100) in float (adapter.ts:94,104). */
  it('6b toPaise rounds a 3-decimal rupee value half-up as documented', () => {
    expect(toPaise(58.455)).toBe(5846);
    expect(toPaise('1.005')).toBe(101);
  });
});
