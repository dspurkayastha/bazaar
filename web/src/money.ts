/** Money is integer paise everywhere. These helpers never touch floating point. */

export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  return head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail;
}

/** 112300 -> "₹1,123"; 112350 -> "₹1,123.50"; 12345678 -> "₹1,23,456.78". */
export function formatRupees(paise: number): string {
  if (!Number.isInteger(paise)) throw new Error('paise must be an integer');
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / 100);
  const rem = abs % 100;
  const body = groupIndian(String(rupees)) + (rem ? '.' + String(rem).padStart(2, '0') : '');
  return (neg ? '-' : '') + '₹' + body;
}

/** Same as formatRupees but always shows two decimals, for receipts. */
export function formatRupeesExact(paise: number): string {
  if (!Number.isInteger(paise)) throw new Error('paise must be an integer');
  const neg = paise < 0;
  const abs = Math.abs(paise);
  return (neg ? '-' : '') + '₹' + groupIndian(String(Math.trunc(abs / 100))) + '.' + String(abs % 100).padStart(2, '0');
}

/** Parse a whole-rupee string such as "500" to paise, or null. */
export function rupeesToPaise(input: string): number | null {
  const m = /^\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}
