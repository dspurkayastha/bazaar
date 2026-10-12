/**
 * Pure helpers that sum ledger spend for "today" and "this month" in the household's timezone.
 * Day and month boundaries are local (Asia/Kolkata by default), not UTC: an order at 23:30 UTC on the 31st
 * is already the 1st in IST.
 */
import type { ISODateTime, Paise } from '../core/types.js';

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export interface SpendRow {
  placedAt: ISODateTime;
  total: Paise;
  status: string;
}

/** Orders that did not (or will not) move money. Pending payments count: money in flight still counts to caps. */
const NON_SPEND = /fail|cancel|refund|declin|abort|reject/i;

export function countsAsSpend(row: Pick<SpendRow, 'status'>): boolean {
  return !NON_SPEND.test(row.status);
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

/** Local calendar date 'YYYY-MM-DD' of an instant in a timezone. */
export function localDate(iso: ISODateTime, tz: string = DEFAULT_TIMEZONE): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`Not an ISO date-time: ${iso}`);
  const parts = formatter(tz).formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Local calendar month 'YYYY-MM'. */
export function localMonth(iso: ISODateTime, tz: string = DEFAULT_TIMEZONE): string {
  return localDate(iso, tz).slice(0, 7);
}

export interface SpendOptions<R extends SpendRow> {
  tz?: string;
  /** Extra filter, e.g. only unattended orders for the daily unattended cap. */
  where?: (row: R) => boolean;
}

function sumWhere<R extends SpendRow>(rows: readonly R[], match: (row: R) => boolean, where?: (row: R) => boolean) {
  let total = 0;
  for (const r of rows) {
    if (!countsAsSpend(r) || !match(r) || (where && !where(r))) continue;
    if (!Number.isSafeInteger(r.total)) throw new TypeError(`ledger total must be integer paise: ${r.total}`);
    total += r.total;
  }
  return total;
}

export function spendToday<R extends SpendRow>(
  rows: readonly R[],
  now: ISODateTime,
  opts: SpendOptions<R> = {},
): Paise {
  const tz = opts.tz ?? DEFAULT_TIMEZONE;
  const day = localDate(now, tz);
  return sumWhere(rows, (r) => localDate(r.placedAt, tz) === day, opts.where);
}

export function spendThisMonth<R extends SpendRow>(
  rows: readonly R[],
  now: ISODateTime,
  opts: SpendOptions<R> = {},
): Paise {
  const tz = opts.tz ?? DEFAULT_TIMEZONE;
  const month = localMonth(now, tz);
  return sumWhere(rows, (r) => localMonth(r.placedAt, tz) === month, opts.where);
}
