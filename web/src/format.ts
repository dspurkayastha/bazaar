const REASONS: Record<string, string> = {
  quote_mismatch: 'The prices changed since this cart was quoted.',
  per_order_ceiling: 'This is over the limit for a single order.',
  daily_cap: 'It would go past today’s spending limit.',
  monthly_cap: 'It would go past this month’s spending limit.',
  category_unattended: 'Something in it needs a person to approve first.',
  category_blocked: 'It has something Bazaar never buys on its own.',
  unit_price_blocked: 'An item costs far more than usual.',
  quantity_bound: 'More of an item than you usually buy.',
  role: 'Only an owner can pay for this.',
  place_untrusted: 'This place is not marked as trusted yet.',
  approval_mismatch: 'The earlier approval was for a different cart.',
  approval_expired: 'The earlier approval ran out.',
  approval_consumed: 'The earlier approval was already used.',
  scheduled_conditions: 'The conditions for this scheduled order are not met.',
  channel_untrusted: 'The request came from a channel that is not verified.',
};

export function humanize(code: string): string {
  const s = code.replace(/[_-]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Reasons arrive as strings (WEB_API) or {rule, detail} objects (voice decision). Return plain words. */
export function reasonText(r: unknown): string {
  if (typeof r === 'string') {
    if (REASONS[r]) return REASONS[r]!;
    return /^[a-z0-9_]+$/.test(r) ? humanize(r) : r;
  }
  if (r && typeof r === 'object') {
    const { rule, detail } = r as { rule?: unknown; detail?: unknown };
    if (typeof rule === 'string' && REASONS[rule]) return REASONS[rule]!;
    if (typeof detail === 'string' && detail) return detail;
    if (typeof rule === 'string') return humanize(rule);
  }
  return 'Needs your approval.';
}

export function nameOf(x: unknown, key: 'name' | 'nickname' = 'name'): string {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    const v = o[key] ?? o.nickname ?? o.name;
    if (typeof v === 'string') return v;
  }
  return '';
}

const TZ = 'Asia/Kolkata';

export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(x);
  const time = new Intl.DateTimeFormat('en-IN', {
    timeZone: TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
  if (day(d) === day(now)) return `Today, ${time}`;
  if (day(d) === day(new Date(now.getTime() - 86_400_000))) return `Yesterday, ${time}`;
  const date = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short' }).format(d);
  return `${date}, ${time}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function currentMonthIST(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(now).slice(0, 7);
}

export function buzz(ms: number | number[] = 10): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not available on iOS Safari */
  }
}
