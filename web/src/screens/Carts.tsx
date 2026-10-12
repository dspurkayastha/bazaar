import { useState } from 'preact/hooks';
import { CartActions } from '../components/CartActions';
import { CartCard, fromHeld } from '../components/CartCard';
import { formatRupees } from '../money';
import { formatWhen, humanize, nameOf } from '../format';
import type { CartsResponse, OrderSummary } from '../types';

export function OrderRow({ o }: { o: OrderSummary }) {
  const place = nameOf(o.place, 'nickname');
  const who = nameOf(o.member);
  return (
    <li class="order-row">
      <div>
        <p class="order-place">{place || 'Order'}</p>
        <p class="order-meta">{[who, formatWhen(o.placedAt), humanize(o.status)].filter(Boolean).join(' · ')}</p>
      </div>
      <span class="amt order-amt">{formatRupees(o.total)}</span>
    </li>
  );
}

export function Carts({
  data,
  error,
  loading,
  refresh,
}: {
  data: CartsResponse | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}) {
  const [done, setDone] = useState<string | null>(null);
  const held = data?.held ?? [];
  const recent = data?.recent ?? [];

  return (
    <section class="screen">
      <header class="screen-head">
        <h1>Carts</h1>
        <button type="button" class="link-btn" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>
      {error && (
        <p class="inline-note" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p class="success-note" role="status">
          {done}
        </p>
      )}

      {data && held.length === 0 && (
        <div class="empty">
          <p class="empty-title">Nothing waiting for approval.</p>
          <p>Tap Talk and say what the house needs. Carts that need a yes will show up here.</p>
        </div>
      )}
      {held.map((h) => (
        <CartCard key={h.quoteHash} cart={fromHeld(h)}>
          <CartActions
            cart={fromHeld(h)}
            builderId={h.member?.id}
            onApproved={(order) => {
              setDone(
                `Ordered from ${h.place?.nickname ?? 'the store'}${order.status ? `: ${humanize(String(order.status))}` : ''}.`,
              );
              void refresh();
            }}
            onRejected={() => {
              setDone('Cart rejected.');
              void refresh();
            }}
          />
        </CartCard>
      ))}

      {recent.length > 0 && (
        <>
          <h2 class="section-title">Recent orders</h2>
          <ul class="order-list">
            {recent.map((o) => (
              <OrderRow key={o.supplierOrderId} o={o} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
