import { useCallback, useEffect, useState } from 'preact/hooks';
import { ApiError, get, post, setUnauthorizedHandler } from './api';
import { TabBar, type Tab } from './components/TabBar';
import { MeContext } from './me';
import { SampleChrome } from './sample/Chrome';
import { isSampleMode } from './sample/mode';
import { PREVIEW_ONLY, showToast } from './sample/toast';
import { Login, Setup } from './screens/Auth';
import { Carts } from './screens/Carts';
import { Household } from './screens/Household';
import { Ledger } from './screens/Ledger';
import { Talk } from './screens/Talk';
import type { CartsResponse, Me } from './types';

const TABS: Tab[] = ['carts', 'talk', 'ledger', 'home'];

function tabFromHash(): Tab {
  const h = location.hash.replace('#', '') as Tab;
  return TABS.includes(h) ? h : 'carts';
}

export function setupCodeFromPath(path: string): string | null {
  const m = /^\/setup\/([^/]+)\/?$/.exec(path);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function App() {
  const [setupCode, setSetupCode] = useState(() => (isSampleMode() ? null : setupCodeFromPath(location.pathname)));
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<'loading' | 'anon' | 'in' | 'error'>('loading');
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [carts, setCarts] = useState<CartsResponse | null>(null);
  const [cartsError, setCartsError] = useState<string | null>(null);
  const [cartsLoading, setCartsLoading] = useState(false);

  const loadMe = useCallback(async () => {
    try {
      setMe(await get<Me>('/api/me'));
      setStatus('in');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        setStatus('anon');
      } else setStatus('error');
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setMe(null);
      setCarts(null);
      setStatus('anon');
    });
    if (!setupCode) void loadMe();
  }, []);

  const loadCarts = useCallback(async () => {
    setCartsLoading(true);
    try {
      setCarts(await get<CartsResponse>('/api/carts'));
      setCartsError(null);
    } catch (e) {
      setCartsError(e instanceof ApiError ? e.message : 'Could not load carts.');
    } finally {
      setCartsLoading(false);
    }
  }, []);

  // Keep carts fresh while signed in and visible: poll, and refresh on return to the app.
  useEffect(() => {
    if (status !== 'in') return;
    void loadCarts();
    const tick = () => document.visibilityState === 'visible' && void loadCarts();
    const id = setInterval(tick, 20_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [status, loadCarts]);

  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `#${t}`);
    window.scrollTo(0, 0);
    if (t === 'carts') void loadCarts();
  };

  const signOut = async () => {
    if (isSampleMode()) return showToast(PREVIEW_ONLY);
    try {
      await post('/api/logout');
    } catch {
      /* cookie may already be gone */
    }
    setMe(null);
    setCarts(null);
    setStatus('anon');
  };

  if (setupCode) {
    return (
      <Setup
        code={setupCode}
        onDone={() => {
          history.replaceState(null, '', '/');
          setSetupCode(null);
          setStatus('loading');
          void loadMe();
        }}
      />
    );
  }
  if (status === 'loading')
    return (
      <main class="auth">
        <p class="auth-sub">Opening Bazaar…</p>
      </main>
    );
  if (status === 'error')
    return (
      <main class="auth">
        <h1 class="auth-title">Can’t reach Bazaar</h1>
        <p class="auth-sub">Check your connection, then try again.</p>
        <button
          type="button"
          class="btn primary wide big"
          onClick={() => {
            setStatus('loading');
            void loadMe();
          }}
        >
          Try again
        </button>
      </main>
    );
  if (status === 'anon' || !me)
    return (
      <Login
        onSignedIn={() => {
          setStatus('loading');
          void loadMe();
        }}
      />
    );

  return (
    <MeContext.Provider value={me}>
      <div class="app">
        {isSampleMode() && <SampleChrome />}
        <div class="view">
          {tab === 'carts' && <Carts data={carts} error={cartsError} loading={cartsLoading} refresh={loadCarts} />}
          {tab === 'talk' && <Talk onSignedOut={() => void loadMe()} onOrdered={() => void loadCarts()} />}
          {tab === 'ledger' && <Ledger />}
          {tab === 'home' && <Household onSignOut={() => void signOut()} onMeChanged={() => void loadMe()} />}
        </div>
        <TabBar tab={tab} onTab={go} badge={carts?.held.filter((h) => h.approvable).length ?? 0} />
      </div>
    </MeContext.Provider>
  );
}
