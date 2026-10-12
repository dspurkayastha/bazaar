import { describe, expect, it } from 'vitest';
import { assertPaise, formatINR, parseRupees, rupees, sumPaise } from '../src/core/money.js';
import { isId, newId } from '../src/core/ids.js';

describe('money', () => {
  it('converts whole rupees to paise', () => {
    expect(rupees(1123)).toBe(112300);
    expect(() => rupees(11.5)).toThrow();
  });

  it('parses supplier rupee strings without float error', () => {
    expect(parseRupees('₹1,123')).toBe(112300);
    expect(parseRupees('58.4')).toBe(5840);
    expect(parseRupees('Rs. 0.29')).toBe(29);
    expect(parseRupees(19.99)).toBe(1999);
    expect(() => parseRupees('12.345')).toThrow();
    expect(() => parseRupees('free')).toThrow();
  });

  it('formats INR with Indian grouping', () => {
    expect(formatINR(112300)).toBe('₹1,123');
    expect(formatINR(5850)).toBe('₹58.50');
    expect(formatINR(800000)).toBe('₹8,000');
    expect(formatINR(12345678900)).toBe('₹12,34,56,789');
    expect(formatINR(0)).toBe('₹0');
    expect(formatINR(-41200)).toBe('-₹412');
    expect(formatINR(50000, { alwaysPaise: true })).toBe('₹500.00');
  });

  it('rejects non-integer paise', () => {
    expect(() => assertPaise(1.5)).toThrow();
    expect(() => sumPaise([100, 0.5])).toThrow();
    expect(sumPaise([100, 200])).toBe(300);
  });
});

describe('ids', () => {
  it('generates sortable, unique ULIDs', () => {
    const a = newId();
    const b = newId('q');
    expect(isId(a)).toBe(true);
    expect(isId(b)).toBe(true);
    expect(b.startsWith('q_')).toBe(true);
    const ids = Array.from({ length: 50 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });
});
