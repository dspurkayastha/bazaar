import { createHash } from 'node:crypto';
import type { Quote } from './types.js';

/** Fields of a quote that the hash covers. Anything else (ids, names, ETA, timestamps) is excluded on purpose. */
export type HashableQuote = Pick<Quote, 'supplierId' | 'placeId' | 'supplierAddressId' | 'fees' | 'total'> & {
  lines: Pick<Quote['lines'][number], 'variantId' | 'quantity' | 'unitPrice'>[];
};

/** Plain code-unit ordering; locale-independent so the hash is identical on every machine. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The canonical pre-image, per docs/CONTRACTS.md "Quote hash":
 *   supplierId | placeId | supplierAddressId | lines sorted by variantId as "variantId:qty:unitPrice" joined "," |
 *   fees sorted as "label:amount" joined "," | total
 */
export function quoteHashInput(q: HashableQuote): string {
  const lines = [...q.lines]
    .sort((a, b) => byCodeUnit(a.variantId, b.variantId) || a.quantity - b.quantity || a.unitPrice - b.unitPrice)
    .map((l) => `${l.variantId}:${l.quantity}:${l.unitPrice}`)
    .join(',');
  const fees = q.fees
    .map((f) => `${f.label}:${f.amount}`)
    .sort(byCodeUnit)
    .join(',');
  return [q.supplierId, q.placeId, q.supplierAddressId, lines, fees, String(q.total)].join('|');
}

/** sha256 hex of the canonical pre-image. Used by both Supplier.quote() and Supplier.readCart(). */
export function quoteHash(q: HashableQuote): string {
  return createHash('sha256').update(quoteHashInput(q), 'utf8').digest('hex');
}

export type HashableLine = Pick<Quote['lines'][number], 'variantId' | 'quantity'>;

/** Canonical line-set pre-image: lines sorted by variantId as "variantId:qty" joined ",". */
export function lineHashInput(lines: readonly HashableLine[]): string {
  return [...lines]
    .sort((a, b) => byCodeUnit(a.variantId, b.variantId) || a.quantity - b.quantity)
    .map((l) => `${l.variantId}:${l.quantity}`)
    .join(',');
}

/**
 * sha256 hex over the sorted lines only (no prices, fees, place or total). Scheduled approvals bind to this via
 * `Approval.conditions.lineHash`, so a fire-time re-quote with the same lines can still be approved.
 */
export function lineHash(lines: readonly HashableLine[]): string {
  return createHash('sha256').update(lineHashInput(lines), 'utf8').digest('hex');
}
