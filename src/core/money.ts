import type { Paise } from './types.js';

export function isPaise(value: unknown): value is Paise {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertPaise(value: unknown, label = 'amount'): asserts value is Paise {
  if (!isPaise(value)) throw new TypeError(`${label} must be integer paise, got ${String(value)}`);
}

/** Whole rupees → paise. rupees(1123) === 112300. */
export function rupees(whole: number): Paise {
  if (!Number.isSafeInteger(whole)) throw new TypeError(`rupees() takes whole rupees, got ${whole}`);
  return whole * 100;
}

/**
 * Parse a rupee amount as a supplier or human writes it ("₹1,123", "1123.5", "Rs. 99.00", 58.4) into paise
 * without float arithmetic on the paise part.
 */
export function parseRupees(input: string | number): Paise {
  const raw = typeof input === 'number' ? String(input) : input;
  const cleaned = raw
    .replace(/₹|rs\.?|inr/gi, '')
    .replace(/[,\s]/g, '')
    .trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw new TypeError(`Not a rupee amount: ${JSON.stringify(input)}`);
  const sign = m[1] ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(2, '0'));
  return sign * (whole * 100 + frac);
}

export function sumPaise(values: Iterable<Paise>): Paise {
  let total = 0;
  for (const v of values) {
    assertPaise(v);
    total += v;
  }
  return total;
}

/** Indian digit grouping: 1234567 → "12,34,567". */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/**
 * Format paise as INR with Indian grouping. Paise are shown only when non-zero unless `alwaysPaise`.
 * formatINR(112300) === "₹1,123"; formatINR(5850) === "₹58.50"; formatINR(12345678900) === "₹12,34,56,789".
 */
export function formatINR(amount: Paise, opts: { alwaysPaise?: boolean } = {}): string {
  assertPaise(amount);
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const fracPart = frac !== 0 || opts.alwaysPaise ? `.${String(frac).padStart(2, '0')}` : '';
  return `${negative ? '-' : ''}₹${groupIndian(String(whole))}${fracPart}`;
}
