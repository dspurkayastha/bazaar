import { useEffect, useState } from 'preact/hooks';
import { ApiError, post } from '../api';
import { formatRupees } from '../money';
import { reasonText } from '../format';
import { useMe } from '../me';
import type { ApproveResponse } from '../types';
import type { CartView } from './CartCard';
import { PinPad, type PinResult } from './PinPad';
import { Sheet } from './Sheet';

type Order = NonNullable<ApproveResponse['order']>;

function attemptsFrom(extra: Record<string, unknown>): number | undefined {
  for (const k of ['attemptsLeft', 'attemptsRemaining', 'remainingAttempts']) {
    const v = extra[k];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

export function CartActions({
  cart,
  builderId,
  autoPin = false,
  onApproved,
  onRejected,
}: {
  cart: CartView;
  /** Member who built the cart; a non-owner may reject only their own. */
  builderId?: string;
  /** Open the PIN pad straight away (voice decision said needsPin). */
  autoPin?: boolean;
  onApproved: (order: Order) => void;
  onRejected: () => void;
}) {
  const me = useMe();
  const isOwner = me.member.role === 'owner';
  const canReject = isOwner || (builderId != null && builderId === me.member.id);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [locked, setLocked] = useState(me.pinLocked);

  useEffect(() => {
    if (autoPin && isOwner && me.pinSet && !locked) setPinOpen(true);
  }, [autoPin]);

  const handle = (r: ApproveResponse): PinResult => {
    if (r.order) {
      setPinOpen(false);
      onApproved(r.order);
      return { ok: true };
    }
    if (r.pinLocked) {
      setLocked(true);
      return { ok: false, message: 'PIN approvals are locked.', locked: true };
    }
    if (r.needsPin) {
      setPinOpen(true);
      return { ok: false, message: '' };
    }
    const decision = typeof r.decision === 'string' ? r.decision : r.decision?.verdict;
    const reasons =
      typeof r.decision === 'object' && r.decision?.reasons ? r.decision.reasons.map(reasonText).join(' ') : '';
    const text =
      decision === 'BLOCK'
        ? `Bazaar will not pay for this one. ${reasons}`.trim()
        : `It is still on hold. ${reasons}`.trim();
    setPinOpen(false);
    setMessage(text);
    return { ok: false, message: text };
  };

  const approve = async () => {
    setMessage(null);
    if (cart.needsPin) {
      if (!me.pinSet) {
        setMessage('Set a PIN first: Home, then Security.');
        return;
      }
      setPinOpen(true);
      return;
    }
    setBusy('approve');
    try {
      handle(await post<ApproveResponse>(`/api/carts/${encodeURIComponent(cart.quoteHash)}/approve`, {}));
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not approve. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const submitPin = async (pin: string): Promise<PinResult> => {
    try {
      return handle(await post<ApproveResponse>(`/api/carts/${encodeURIComponent(cart.quoteHash)}/approve`, { pin }));
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 423) {
          setLocked(true);
          return { ok: false, message: e.message, locked: true };
        }
        if (e.status === 401) return { ok: false, message: e.message };
        const left = attemptsFrom(e.extra);
        return {
          ok: false,
          message: e.status === 403 || e.status === 400 ? 'That PIN is not right.' : e.message,
          attemptsLeft: left,
        };
      }
      return { ok: false, message: 'Could not check the PIN. Try again.' };
    }
  };

  const reject = async () => {
    setMessage(null);
    setBusy('reject');
    try {
      await post(`/api/carts/${encodeURIComponent(cart.quoteHash)}/reject`);
      onRejected();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not reject. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="cart-actions">
      {message && (
        <p class="inline-note" role="alert">
          {message}
        </p>
      )}
      {isOwner ? (
        cart.approvable ? (
          <div class="action-row">
            <button
              type="button"
              class="btn ghost"
              disabled={busy !== null || !canReject}
              onClick={() => void reject()}
            >
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
            <button type="button" class="btn primary" disabled={busy !== null} onClick={() => void approve()}>
              {busy === 'approve'
                ? 'Approving…'
                : cart.needsPin
                  ? `Approve ${formatRupees(cart.total)} with PIN`
                  : `Approve ${formatRupees(cart.total)}`}
            </button>
          </div>
        ) : (
          <div class="action-row">
            <p class="inline-note">Bazaar will not pay for this one, so it cannot be approved.</p>
            <button type="button" class="btn ghost" disabled={busy !== null} onClick={() => void reject()}>
              Reject
            </button>
          </div>
        )
      ) : (
        <div class="action-row">
          <p class="inline-note">Waiting for an owner to approve.</p>
          {canReject && (
            <button type="button" class="btn ghost" disabled={busy !== null} onClick={() => void reject()}>
              Reject
            </button>
          )}
        </div>
      )}
      {pinOpen && (
        <Sheet title="Enter PIN" onClose={() => setPinOpen(false)}>
          <PinPad
            title={`Approve ${formatRupees(cart.total)}`}
            hint={`For ${cart.placeName || 'this cart'}. Enter your PIN.`}
            submitLabel={`Approve ${formatRupees(cart.total)}`}
            locked={locked}
            onSubmit={submitPin}
            onCancel={() => setPinOpen(false)}
          />
        </Sheet>
      )}
    </div>
  );
}
