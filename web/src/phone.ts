/** Normalise a typed phone number to E.164. Bare 10-digit Indian mobiles get +91. Returns null if invalid. */
export function toE164(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const plus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  let out: string;
  if (plus) out = '+' + digits;
  else if (digits.length === 10 && /^[6-9]/.test(digits)) out = '+91' + digits;
  else if (digits.length === 11 && digits.startsWith('0') && /^[6-9]/.test(digits.slice(1)))
    out = '+91' + digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('91')) out = '+' + digits;
  else if (digits.startsWith('00')) out = '+' + digits.slice(2);
  else return null;
  return /^\+[1-9]\d{7,14}$/.test(out) ? out : null;
}

export function parsePhones(text: string): { phones: string[]; invalid: string[] } {
  const phones: string[] = [];
  const invalid: string[] = [];
  for (const part of text
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    const p = toE164(part);
    if (p) {
      if (!phones.includes(p)) phones.push(p);
    } else invalid.push(part);
  }
  return { phones, invalid };
}
