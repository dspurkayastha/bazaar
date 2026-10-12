/** Small identity helpers shared by the stores, the seed and the web API: place keys and phone numbers. */

/**
 * Place key from a nickname: lower case, apostrophes dropped, every other run of non [a-z0-9] → "-", trimmed.
 * "Rahul's" → "rahuls", "Didi's flat" → "didis-flat". Mirrors the SQL backfill in drizzle/0004_web_identity.sql.
 */
export function slugify(nickname: string): string {
  return nickname
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A key not in `taken`: the slug, else slug-2, slug-3 … ("place" when the nickname has no latin letters/digits). */
export function uniqueKey(nickname: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(nickname) || 'place';
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** E.164: "+", a non-zero country code digit, 8–15 digits in all. No spaces or punctuation. */
export function isE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

/** Lenient input → E.164: strips spaces, dashes, dots and brackets; undefined when it still is not E.164. */
export function normalisePhone(raw: string): string | undefined {
  const p = raw.trim().replace(/[\s\-().]/g, '');
  return isE164(p) ? p : undefined;
}
