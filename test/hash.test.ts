import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { quoteHash, quoteHashInput, type HashableQuote } from '../src/core/hash.js';

const base: HashableQuote = {
  supplierId: 'instamart',
  placeId: 'pl_home',
  supplierAddressId: 'addr-1',
  lines: [
    { variantId: 'v-milk', quantity: 2, unitPrice: 12000 },
    { variantId: 'v-rice', quantity: 1, unitPrice: 18000 },
    { variantId: 'v-chicken', quantity: 2, unitPrice: 26000 },
  ],
  fees: [
    { label: 'handling', amount: 800 },
    { label: 'delivery', amount: 1500 },
  ],
  total: 112300,
};

describe('quoteHash', () => {
  it('matches the contract pre-image exactly', () => {
    expect(quoteHashInput(base)).toBe(
      'instamart|pl_home|addr-1|v-chicken:2:26000,v-milk:2:12000,v-rice:1:18000|delivery:1500,handling:800|112300',
    );
    expect(quoteHash(base)).toBe(createHash('sha256').update(quoteHashInput(base)).digest('hex'));
    expect(quoteHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic regardless of line and fee order', () => {
    const shuffled: HashableQuote = {
      ...base,
      lines: [base.lines[2]!, base.lines[0]!, base.lines[1]!],
      fees: [base.fees[1]!, base.fees[0]!],
    };
    expect(quoteHash(shuffled)).toBe(quoteHash(base));
    expect(quoteHash(base)).toBe(quoteHash(structuredClone(base)));
  });

  it('ignores fields outside the contract (names, ETA, ids)', () => {
    const withExtras = {
      ...base,
      id: 'q_1',
      etaMinutes: 12,
      lines: base.lines.map((l) => ({ ...l, name: 'whatever', label: 'x' })),
    };
    expect(quoteHash(withExtras)).toBe(quoteHash(base));
  });

  it.each([
    ['quantity', { ...base, lines: [{ ...base.lines[0]!, quantity: 3 }, base.lines[1]!, base.lines[2]!] }],
    ['unit price', { ...base, lines: [{ ...base.lines[0]!, unitPrice: 12100 }, base.lines[1]!, base.lines[2]!] }],
    ['fee', { ...base, fees: [{ label: 'handling', amount: 900 }, base.fees[1]!] }],
    ['total', { ...base, total: 112400 }],
    ['place', { ...base, placeId: 'pl_hospital' }],
    ['address', { ...base, supplierAddressId: 'addr-2' }],
    ['supplier', { ...base, supplierId: 'blinkit' as const }],
    ['dropped line', { ...base, lines: base.lines.slice(1) }],
  ])('changes when the %s changes', (_label, changed) => {
    expect(quoteHash(changed)).not.toBe(quoteHash(base));
  });
});
