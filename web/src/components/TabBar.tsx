export type Tab = 'carts' | 'talk' | 'ledger' | 'home';

const ICONS: Record<Tab, string> = {
  carts: 'M5 7h14l-1.4 9.1a2 2 0 0 1-2 1.7H8.4a2 2 0 0 1-2-1.7L5 7Zm0 0-.6-2.4A1 1 0 0 0 3.4 4H2M9 7a3 3 0 0 1 6 0',
  talk: 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-6 8a6 6 0 0 0 12 0M12 17v4M8.5 21h7',
  ledger: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6M9 12h6',
  home: 'M3.5 11 12 4l8.5 7M6 9.5V20h12V9.5M10 20v-5h4v5',
};

const LABELS: Record<Tab, string> = { carts: 'Carts', talk: 'Talk', ledger: 'Ledger', home: 'Home' };

export function TabBar({ tab, onTab, badge }: { tab: Tab; onTab: (t: Tab) => void; badge: number }) {
  return (
    <nav class="tabbar" aria-label="Main">
      {(['carts', 'talk', 'ledger', 'home'] as Tab[]).map((t) => (
        <button
          key={t}
          type="button"
          class={'tab' + (tab === t ? ' active' : '') + (t === 'talk' ? ' talk' : '')}
          aria-current={tab === t ? 'page' : undefined}
          onClick={() => onTab(t)}
        >
          <span class="tab-icon">
            <svg
              viewBox="0 0 24 24"
              width="26"
              height="26"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d={ICONS[t]} />
            </svg>
            {t === 'carts' && badge > 0 && (
              <span class="badge" aria-label={`${badge} waiting`}>
                {badge}
              </span>
            )}
          </span>
          <span class="tab-label">{LABELS[t]}</span>
        </button>
      ))}
    </nav>
  );
}
