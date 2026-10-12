/**
 * The first live get_cart (VPS, 12 Oct 2026), PII masked. The builder's guessed shapes missed: unit price in
 * item.discountedFinalPrice, name in itemName, variant in itemVariant, toPay as a {label,value} object,
 * To Pay rounded to the rupee, and a short address id ("<base>" vs saved "<base>__<suffix>").
 */
import { describe, expect, it } from 'vitest';
import { QuoteMismatch } from '../src/core/errors.js';
import type { Place } from '../src/core/types.js';
import { InstamartSupplier, sameAddress } from '../src/suppliers/instamart/adapter.js';
import { fakeTool, fixture, HOME, NOW } from './fixtures/instamart/harness.js';

const LIVE_HOME: Place = {
  ...HOME,
  supplierAddressIds: { instamart: 'd4qog5cbifjahfg3lj7g__AXrN3QWH1x4X8mV9ooN8Qx' },
};

function supplierWith(cart: unknown) {
  const tool = fakeTool({ get_cart: cart, update_cart: { success: true } });
  return new InstamartSupplier({ callTool: tool.callTool, now: () => NOW });
}

describe('Instamart live get_cart shape (12 Oct 2026)', () => {
  it('reads the real cart and reconciles it to the paise, with an explicit rounding line', async () => {
    const q = await supplierWith(fixture('get_cart.live-2026-10-12')).readCart(LIVE_HOME);
    expect(q.lines).toHaveLength(8);
    const curd = q.lines.find((l) => l.variantId === 'W4FDN6IC6P');
    expect(curd).toMatchObject({
      name: 'Purabi Plain Curd',
      label: '80 g',
      quantity: 5,
      unitPrice: 1500,
      lineTotal: 7500,
    });
    expect(q.itemTotal).toBe(138300);
    expect(q.fees).toEqual(
      expect.arrayContaining([
        { label: 'handling', amount: 1298 },
        { label: 'rounding', amount: 2 },
      ]),
    );
    expect(q.fees.find((f) => f.label === 'value')).toBeUndefined(); // toPay must not become a fee
    expect(q.total).toBe(139600);
    expect(q.itemTotal + q.fees.reduce((s, f) => s + f.amount, 0)).toBe(q.total);
  });

  it('accepts the short address id get_cart reports for the long saved-address id', async () => {
    expect(sameAddress('d4qog5cbifjahfg3lj7g', 'd4qog5cbifjahfg3lj7g__AXrN3QWH1x4X8mV9ooN8Qx')).toBe(true);
    expect(sameAddress('d7uqnko0hph36i9dkpag', 'd4qog5cbifjahfg3lj7g__AXrN3QWH1x4X8mV9ooN8Qx')).toBe(false);
  });

  it('still refuses a cart priced for a different address', async () => {
    const other: Place = {
      ...LIVE_HOME,
      supplierAddressIds: { instamart: 'd7uqnko0hph36i9dkpag__AXoSkwWH9u4vVXa2sDMjhK' },
    };
    await expect(supplierWith(fixture('get_cart.live-2026-10-12')).readCart(other)).rejects.toBeInstanceOf(
      QuoteMismatch,
    );
  });

  it('does not paper over a real mismatch: more than a rupee off still refuses', async () => {
    const cart = fixture<{ billBreakdown: { toPay: { value: string } } }>('get_cart.live-2026-10-12');
    cart.billBreakdown.toPay.value = '₹1400';
    await expect(supplierWith(cart).readCart(LIVE_HOME)).rejects.toThrow(/does not reconcile/);
  });
});
