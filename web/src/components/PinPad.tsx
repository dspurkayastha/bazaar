import { useEffect, useState } from 'preact/hooks';
import { buzz } from '../format';

export type PinResult = { ok: true } | { ok: false; message: string; attemptsLeft?: number; locked?: boolean };

export const PIN_MIN = 4;
export const PIN_MAX = 6;

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export function PinPad({
  title,
  hint,
  submitLabel,
  onSubmit,
  onCancel,
  locked: lockedProp = false,
  minLength = PIN_MIN,
  maxLength = PIN_MAX,
}: {
  title: string;
  hint?: string;
  submitLabel: string;
  onSubmit: (pin: string) => Promise<PinResult>;
  onCancel: () => void;
  locked?: boolean;
  minLength?: number;
  maxLength?: number;
}) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [lockedState, setLocked] = useState(false);
  const locked = lockedProp || lockedState;
  const disabled = busy || locked;

  const press = (d: string) => {
    if (disabled) return;
    buzz(8);
    setError(null);
    setPin((p) => (p.length < maxLength ? p + d : p));
  };
  const back = () => {
    if (disabled) return;
    buzz(8);
    setPin((p) => p.slice(0, -1));
  };
  const submit = async () => {
    if (disabled || pin.length < minLength) return;
    setBusy(true);
    setError(null);
    try {
      const r = await onSubmit(pin);
      if (!r.ok) {
        buzz([30, 40, 30]);
        setError(r.message);
        setAttemptsLeft(r.attemptsLeft ?? null);
        if (r.locked) setLocked(true);
        setPin('');
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') back();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <div class="pinpad">
      <h2 class="pin-title">{title}</h2>
      {hint && <p class="pin-hint">{hint}</p>}
      <div class="pin-dots" role="img" aria-label={`${pin.length} of ${maxLength} digits entered`}>
        {Array.from({ length: maxLength }, (_, i) => (
          <span key={i} class={'pin-dot' + (i < pin.length ? ' on' : '') + (error ? ' bad' : '')} />
        ))}
      </div>
      <p class="pin-status" role="alert">
        {locked
          ? 'PIN approvals are locked after too many wrong tries. Try again in 15 minutes, or ask an owner to reset it.'
          : error
            ? `${error}${attemptsLeft != null ? ` ${attemptsLeft} ${attemptsLeft === 1 ? 'try' : 'tries'} left.` : ''}`
            : ''}
      </p>
      <div class="pin-keys">
        {KEYS.map((k) => (
          <button key={k} type="button" class="pin-key" disabled={disabled} onClick={() => press(k)}>
            {k}
          </button>
        ))}
        <button type="button" class="pin-key ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" class="pin-key" disabled={disabled} onClick={() => press('0')}>
          0
        </button>
        <button
          type="button"
          class="pin-key ghost"
          disabled={disabled || !pin}
          onClick={back}
          aria-label="Delete last digit"
        >
          ⌫
        </button>
      </div>
      <button
        type="button"
        class="btn primary wide"
        disabled={disabled || pin.length < minLength}
        onClick={() => void submit()}
      >
        {busy ? 'Checking…' : submitLabel}
      </button>
    </div>
  );
}
