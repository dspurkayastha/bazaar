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

/**
 * Parse a rupee amount with any number of decimals into paise, rounding half-up (away from zero) on the third
 * decimal. String decomposition only, no float multiplication: 1.005 → 101, 58.455 → 5846, "₹1,123.00" → 112300.
 * Numbers go through String(n), the shortest round-trip decimal, so 0.1 + 0.2 ("0.30000000000000004") → 30.
 * Accepts currency marks, digit grouping, a sign and exponent forms ("1.5e2"). Throws on anything else.
 */
export function parseRupeesRounded(input: string | number): Paise {
  if (typeof input === 'number' && !Number.isFinite(input)) throw new TypeError(`Not a rupee amount: ${input}`);
  const raw = typeof input === 'number' ? String(input) : input;
  const cleaned = raw
    .replace(/₹|rs\.?|inr/gi, '')
    .replace(/[,\s]/g, '')
    .trim();
  const m = /^([-+])?(\d*)(?:\.(\d*))?(?:e([-+]?\d+))?$/i.exec(cleaned);
  if (!m || (m[2] ?? '') + (m[3] ?? '') === '') throw new TypeError(`Not a rupee amount: ${JSON.stringify(input)}`);
  let intPart = m[2] ?? '';
  let fracPart = m[3] ?? '';
  const exp = m[4] === undefined ? 0 : Number(m[4]);
  if (Math.abs(exp) > 30) throw new TypeError(`Rupee amount out of range: ${raw}`);
  // Move the decimal point by the exponent on the digit strings.
  if (exp > 0) {
    const moved = fracPart.padEnd(exp, '0');
    intPart += moved.slice(0, exp);
    fracPart = moved.slice(exp);
  } else if (exp < 0) {
    const moved = intPart.padStart(-exp, '0');
    fracPart = moved.slice(moved.length + exp) + fracPart;
    intPart = moved.slice(0, moved.length + exp);
  }
  const digits = (intPart.replace(/^0+/, '') || '0') + fracPart.padEnd(2, '0').slice(0, 2);
  if (digits.length > 15) throw new TypeError(`Rupee amount out of range: ${raw}`);
  let paise = Number(digits); // a plain integer digit string: exact
  const third = fracPart.charAt(2);
  if (third !== '' && third >= '5') paise += 1;
  return m[1] === '-' && paise !== 0 ? -paise : paise;
}
