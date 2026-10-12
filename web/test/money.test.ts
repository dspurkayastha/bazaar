import { describe, expect, it } from 'vitest';
import { formatRupees, formatRupeesExact, groupIndian, rupeesToPaise } from '../src/money';
import { toE164, parsePhones } from '../src/phone';
import { reasonText, shiftMonth, monthLabel } from '../src/format';

describe('formatRupees', () => {
  it('uses Indian grouping from integer paise', () => {
    expect(formatRupees(0)).toBe('₹0');
    expect(formatRupees(99)).toBe('₹0.99');
    expect(formatRupees(50000)).toBe('₹500');
    expect(formatRupees(112300)).toBe('₹1,123');
    expect(formatRupees(112350)).toBe('₹1,123.50');
    expect(formatRupees(10000000)).toBe('₹1,00,000');
    expect(formatRupees(12345678)).toBe('₹1,23,456.78');
    expect(formatRupees(123456789012)).toBe('₹1,23,45,67,890.12');
  });
  it('handles negatives and padding', () => {
    expect(formatRupees(-250)).toBe('-₹2.50');
    expect(formatRupees(105)).toBe('₹1.05');
    expect(formatRupeesExact(112300)).toBe('₹1,123.00');
  });
  it('rejects non-integer paise', () => {
    expect(() => formatRupees(10.5)).toThrow();
  });
  it('groups digit strings', () => {
    expect(groupIndian('999')).toBe('999');
    expect(groupIndian('1000')).toBe('1,000');
    expect(groupIndian('100000')).toBe('1,00,000');
  });
  it('parses rupee input without floats', () => {
    expect(rupeesToPaise('500')).toBe(50000);
    expect(rupeesToPaise('12.5')).toBe(1250);
    expect(rupeesToPaise('0.07')).toBe(7);
    expect(rupeesToPaise('abc')).toBeNull();
  });
});

describe('phone helper', () => {
  it('adds +91 to Indian mobiles', () => {
    expect(toE164('98765 43210')).toBe('+919876543210');
    expect(toE164('098765-43210')).toBe('+919876543210');
    expect(toE164('919876543210')).toBe('+919876543210');
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
  });
  it('rejects junk', () => {
    expect(toE164('12345')).toBeNull();
    expect(toE164('')).toBeNull();
  });
  it('splits lists', () => {
    expect(parsePhones('9876543210, +919876543210, nope')).toEqual({ phones: ['+919876543210'], invalid: ['nope'] });
  });
});

describe('format helpers', () => {
  it('turns rule codes into plain words', () => {
    expect(reasonText('per_order_ceiling')).toMatch(/limit/);
    expect(reasonText({ rule: 'place_untrusted', detail: 'x' })).toMatch(/trusted/);
    expect(reasonText('Over your limit.')).toBe('Over your limit.');
  });
  it('shifts months across years', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(monthLabel('2026-10')).toBe('October 2026');
  });
});
