import { useEffect, useState } from 'preact/hooks';
import { ApiError, get } from '../api';
import { currentMonthIST, humanize, monthLabel, shiftMonth } from '../format';
import { formatRupees } from '../money';
import type { LedgerSummary, SpendBucket } from '../types';

export function Bars({ title, items, label }: { title: string; items: SpendBucket[]; label?: (k: string) => string }) {
  if (!items.length) return null;
  const max = Math.max(...items.map((i) => i.total), 1);
  return (
    <section class="bars">
      <h2 class="section-title">{title}</h2>
      <ul>
        {items.map((i) => (
          <li key={i.key}>
            <div class="bar-row">
              <span class="bar-label">{label ? label(i.key) : i.key}</span>
              <span class="amt">{formatRupees(i.total)}</span>
            </div>
            <div class="bar-track" aria-hidden="true">
              <div class="bar-fill" style={{ width: `${Math.max(2, Math.round((i.total / max) * 100))}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Ledger() {
  const thisMonth = currentMonthIST();
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState<LedgerSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    get<LedgerSummary>(`/api/ledger?month=${month}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : 'Could not load the ledger.'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [month]);

  const saved = data?.smallOrders.batchingWouldHaveSaved ?? 0;

  return (
    <section class="screen">
      <header class="screen-head">
        <h1>Ledger</h1>
      </header>
      <div class="month-picker">
        <button
          type="button"
          class="icon-btn"
          aria-label="Previous month"
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          ‹
        </button>
        <span class="month-label" aria-live="polite">
          {monthLabel(month)}
        </span>
        <button
          type="button"
          class="icon-btn"
          aria-label="Next month"
          disabled={month >= thisMonth}
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          ›
        </button>
      </div>
      {error && (
        <p class="inline-note" role="alert">
          {error}
        </p>
      )}
      {loading && !data && <p class="muted">Loading…</p>}
      {data && data.month === month && (
        <div class={loading ? 'dim' : ''}>
          <div class="ledger-total">
            <p class="ledger-big amt">{formatRupees(data.total)}</p>
            <p class="muted">
              {data.orderCount} {data.orderCount === 1 ? 'order' : 'orders'}, of which {formatRupees(data.fees.total)}{' '}
              was fees
            </p>
          </div>
          {data.orderCount === 0 && (
            <div class="empty">
              <p class="empty-title">No orders in {monthLabel(month)}.</p>
            </div>
          )}
          {saved > 0 && (
            <p class="saving">
              Batching would have saved <strong class="amt">{formatRupees(saved)}</strong> across{' '}
              {data.smallOrders.count} small {data.smallOrders.count === 1 ? 'order' : 'orders'}.
            </p>
          )}
          <Bars title="By member" items={data.byMember} />
          <Bars title="By place" items={data.byPlace} />
          <Bars title="By category" items={data.byCategory} label={humanize} />
          {data.fees.byLabel.length > 0 && (
            <Bars title="Fees" items={data.fees.byLabel.map((f) => ({ key: f.label, total: f.total, count: 0 }))} />
          )}
        </div>
      )}
    </section>
  );
}
