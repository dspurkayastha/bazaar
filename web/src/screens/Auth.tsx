import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchLoginOptions, fetchSetupOptions, finishSetup, describeWebAuthnError, signIn } from '../passkeys';
import { ApiError } from '../api';

function Mark() {
  return (
    <div class="auth-mark" aria-hidden="true">
      <svg viewBox="0 0 64 64" width="64" height="64">
        <circle cx="32" cy="32" r="30" fill="var(--accent)" />
        <path
          d="M20 26h24l-2.4 16a3 3 0 0 1-3 2.5H25.4a3 3 0 0 1-3-2.5L20 26Zm5 0a7 7 0 0 1 14 0"
          fill="none"
          stroke="var(--on-accent)"
          stroke-width="3"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </div>
  );
}

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const opts = useRef<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch options ahead of the tap so Safari still treats the passkey prompt as user-initiated.
  const prefetch = async () => {
    try {
      opts.current = await fetchLoginOptions();
    } catch (e) {
      opts.current = null;
      setError(e instanceof ApiError ? e.message : 'Could not reach Bazaar.');
    }
  };
  useEffect(() => {
    void prefetch();
  }, []);

  const go = async () => {
    if (!opts.current) {
      setError(null);
      await prefetch();
      if (!opts.current) return;
    }
    setBusy(true);
    setError(null);
    const o = opts.current;
    opts.current = null;
    try {
      await signIn(o);
      onSignedIn();
    } catch (e) {
      setError(describeWebAuthnError(e));
      void prefetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="auth">
      <Mark />
      <h1 class="auth-title">Bazaar</h1>
      <p class="auth-sub">Your household’s shopping, in one voice.</p>
      <button type="button" class="btn primary wide big" disabled={busy} onClick={() => void go()}>
        {busy ? 'Waiting for Face ID…' : 'Sign in with Face ID'}
      </button>
      {error && (
        <p class="inline-note" role="alert">
          {error}
        </p>
      )}
      <p class="auth-foot">New here? Ask the owner for a setup link.</p>
    </main>
  );
}

export function Setup({ code, onDone }: { code: string; onDone: () => void }) {
  const [state, setState] = useState<'loading' | 'ready' | 'invalid'>('loading');
  const [name, setName] = useState('');
  const options = useRef<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSetupOptions(code)
      .then((r) => {
        options.current = r.options;
        setName(r.name);
        setState('ready');
      })
      .catch((e) => {
        setState('invalid');
        setError(
          e instanceof ApiError && e.status !== 0 && e.status < 500
            ? 'This setup link has expired or was already used. Ask the owner for a new one.'
            : e instanceof ApiError
              ? e.message
              : 'Could not open this link.',
        );
      });
  }, [code]);

  const go = async () => {
    if (!options.current) return;
    setBusy(true);
    setError(null);
    try {
      await finishSetup(code, options.current);
      onDone();
    } catch (e) {
      setError(describeWebAuthnError(e));
      // The challenge is single use; fetch a fresh one for the next try.
      try {
        options.current = (await fetchSetupOptions(code)).options;
      } catch {
        /* link may now be spent */
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="auth">
      <Mark />
      {state === 'loading' && <p class="auth-sub">Opening your link…</p>}
      {state === 'ready' && (
        <>
          <h1 class="auth-title">{name ? `Set up Bazaar for ${name}` : 'Set up Bazaar'}</h1>
          <p class="auth-sub">Your phone will ask for Face ID once. After that, Face ID is how you sign in.</p>
          <button type="button" class="btn primary wide big" disabled={busy} onClick={() => void go()}>
            {busy ? 'Waiting for Face ID…' : 'Create my passkey'}
          </button>
        </>
      )}
      {state === 'invalid' && <h1 class="auth-title">Link not valid</h1>}
      {error && (
        <p class="inline-note" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
