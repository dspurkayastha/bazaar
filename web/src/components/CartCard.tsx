import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { formatRupees } from '../money';
import { nameOf, reasonText } from '../format';
import type { CartFee, CartLine, HeldCart } from '../types';
import type { VoiceQuote } from '../voice/reducer';

/** One shape for both the held-cart list and the voice `cart` message. */
export interface CartView {
  quoteHash: string;
  memberName?: string;
  placeName: string;
  supplier: string;
  lines: CartLine[];
  fees: CartFee[];
  total: number;
  etaMinutes?: number;
  reasons: unknown[];
  needsPin: boolean;
  approvable: boolean;
  removed?: { name: string; qty?: number }[];
}

export function fromHeld(h: HeldCart): CartView {
  return {
    quoteHash: h.quoteHash,
    memberName: h.member?.name,
    placeName: h.place?.nickname ?? '',
    supplier: h.supplier,
    lines: h.lines,
    fees: h.fees,
    total: h.total,
    etaMinutes: h.etaMinutes,
    reasons: h.reasons ?? [],
    needsPin: h.needsPin,
    approvable: h.approvable,
  };
}

export function fromQuote(
  q: VoiceQuote,
  extra: {
    reasons?: unknown[];
    needsPin?: boolean;
    approvable?: boolean;
    removed?: { name: string; qty?: number }[];
  } = {},
): CartView {
  return {
    quoteHash: q.hash,
    placeName: nameOf(q.place, 'nickname'),
    supplier: q.supplier,
    lines: q.lines,
    fees: q.fees,
    total: q.total,
    etaMinutes: q.etaMinutes,
    reasons: extra.reasons ?? [],
    needsPin: extra.needsPin ?? false,
    approvable: extra.approvable ?? true,
    removed: extra.removed,
  };
}

export const MAX_LINES = 5;

export function CartCard({ cart, children }: { cart: CartView; children?: ComponentChildren }) {
  const [all, setAll] = useState(false);
  const shown = all ? cart.lines : cart.lines.slice(0, MAX_LINES);
  const more = cart.lines.length - shown.length;
  const reasons = cart.reasons.map(reasonText);
  return (
    <article class="ticket" aria-label={`Cart for ${cart.placeName}, ${formatRupees(cart.total)}`}>
      <header class="ticket-head">
        <div>
          <h3 class="ticket-place">{cart.placeName || 'Unknown place'}</h3>
          <p class="ticket-meta">
            {[
              cart.memberName && `${cart.memberName} asked`,
              cart.supplier,
              cart.etaMinutes != null && `about ${cart.etaMinutes} min`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      </header>

      {reasons.length > 0 && (
        <ul class="hold-reasons">
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      <ul class="ticket-lines">
        {shown.map((l, i) => (
          <li key={i}>
            <span class="line-name">
              <span class="line-qty">{l.qty}×</span> {l.name}
              {l.label && <span class="line-label"> {l.label}</span>}
            </span>
            <span class="amt">{formatRupees(l.lineTotal)}</span>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button type="button" class="link-btn" onClick={() => setAll(true)}>
          {more} more
        </button>
      )}
      {all && cart.lines.length > MAX_LINES && (
        <button type="button" class="link-btn" onClick={() => setAll(false)}>
          Show fewer
        </button>
      )}

      {cart.removed && cart.removed.length > 0 && (
        <p class="removed-note">
          Left out: {cart.removed.map((r) => (r.qty && r.qty > 1 ? `${r.qty}× ${r.name}` : r.name)).join(', ')}
        </p>
      )}

      <div class="perf" aria-hidden="true" />
      {cart.fees.length > 0 && (
        <ul class="ticket-fees">
          {cart.fees.map((f, i) => (
            <li key={i}>
              <span>{f.label}</span>
              <span class="amt">{formatRupees(f.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      <div class="ticket-total">
        <span>Total</span>
        <strong class="amt">{formatRupees(cart.total)}</strong>
      </div>
      {children}
    </article>
  );
}
