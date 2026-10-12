import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { CartActions } from '../components/CartActions';
import { CartCard, fromQuote } from '../components/CartCard';
import { buzz, humanize, reasonText } from '../format';
import { useMe } from '../me';
import { initialVoiceState, voiceReducer, type Orb } from '../voice/reducer';
import { MicError, VoiceSession } from '../voice/session';

const ORB_LABEL: Record<Orb, string> = {
  off: 'Tap to talk',
  connecting: 'Connecting…',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking. Tap to stop.',
};

export function Talk({ onSignedOut, onOrdered }: { onSignedOut: () => void; onOrdered: () => void }) {
  const me = useMe();
  const [s, dispatch] = useReducer(voiceReducer, initialVoiceState);
  const session = useRef<VoiceSession | null>(null);
  const [micError, setMicError] = useState<string | null>(null);

  const active = s.orb !== 'off';

  const start = async () => {
    setMicError(null);
    const sess = new VoiceSession(dispatch);
    session.current = sess;
    buzz(12);
    try {
      await sess.start();
    } catch (e) {
      session.current = null;
      dispatch({ type: 'local/closed', code: 1000 });
      setMicError(e instanceof MicError ? e.message : 'Could not start voice. Try again.');
    }
  };

  const stop = () => {
    session.current?.stop();
    session.current = null;
  };

  const onOrb = () => {
    if (!active) void start();
    else if (s.orb === 'speaking' || s.orb === 'thinking') {
      buzz(12);
      session.current?.interrupt();
    }
  };

  // Release the mic whenever the page is hidden or this screen goes away.
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', stop);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', stop);
      stop();
    };
  }, []);

  useEffect(() => {
    if (s.closeCode === 4401) onSignedOut();
  }, [s.closeCode]);

  useEffect(() => {
    if (s.order) {
      buzz([20, 40, 20]);
      onOrdered();
    }
  }, [s.order?.supplierOrderId]);

  const decision = s.decision;
  const cartView = s.cart
    ? fromQuote(s.cart.quote, {
        reasons: decision?.reasons ?? [],
        needsPin: decision?.needsPin ?? false,
        approvable: decision ? decision.verdict !== 'BLOCK' : true,
        removed: s.cart.removed,
      })
    : null;

  return (
    <section class="screen talk">
      <header class="screen-head">
        <h1>Talk</h1>
        {active && (
          <button type="button" class="link-btn" onClick={stop}>
            End
          </button>
        )}
      </header>

      <div class="captions" aria-live="polite">
        <p class="cap-heard">{s.heard?.text ?? (active ? '' : 'Say it in Bengali, Hindi or English.')}</p>
        <p class="cap-say">{s.say?.text ?? ''}</p>
      </div>

      <div class="orb-wrap">
        <button
          type="button"
          class="orb"
          data-state={s.orb}
          aria-label={ORB_LABEL[s.orb]}
          aria-pressed={active}
          onClick={onOrb}
        >
          <span class="orb-ring" />
          <span class="orb-core" />
        </button>
        <p class="orb-label">{ORB_LABEL[s.orb]}</p>
        {s.member && s.place?.nickname && active && <p class="muted small">Shopping for {s.place.nickname}</p>}
      </div>

      {micError && (
        <p class="inline-note" role="alert">
          {micError}
        </p>
      )}
      {s.error && (
        <p class="inline-note" role="alert">
          {s.error.message}
        </p>
      )}

      {s.order && (
        <div class="success-card" role="status">
          <p class="success-title">Order placed</p>
          <p class="muted">
            {humanize(s.order.status)}
            {s.order.etaMinutes != null ? `, about ${s.order.etaMinutes} min away` : ''}
          </p>
        </div>
      )}

      {cartView && (
        <>
          {decision?.verdict === 'BLOCK' && (
            <p class="inline-note">
              {decision.reasons.map(reasonText).join(' ') || 'Bazaar will not pay for this one.'}
            </p>
          )}
          <CartCard cart={cartView}>
            <CartActions
              cart={cartView}
              builderId={me.member.id}
              autoPin={decision?.needsPin ?? false}
              onApproved={(order) =>
                dispatch({
                  type: 'local/order',
                  supplierOrderId: String(order.supplierOrderId ?? ''),
                  status: String(order.status ?? 'placed'),
                  etaMinutes: typeof order.etaMinutes === 'number' ? order.etaMinutes : undefined,
                })
              }
              onRejected={() => {
                session.current?.cancel();
                dispatch({ type: 'local/cart_done' });
              }}
            />
          </CartCard>
        </>
      )}
    </section>
  );
}
