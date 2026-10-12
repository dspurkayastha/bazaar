import { describe, expect, it } from 'vitest';
import {
  closeMessage,
  initialVoiceState,
  voiceReducer,
  type ServerMessage,
  type VoiceState,
} from '../src/voice/reducer';

const quote = {
  hash: 'h1',
  supplier: 'instamart',
  place: { key: 'p1', nickname: 'Silchar flat' },
  lines: [{ name: 'Curd', label: '400 g', qty: 2, lineTotal: 12000 }],
  fees: [{ label: 'Handling', amount: 500 }],
  total: 12500,
  etaMinutes: 14,
};

const run = (msgs: Parameters<typeof voiceReducer>[1][], from: VoiceState = initialVoiceState) =>
  msgs.reduce(voiceReducer, from);

describe('voiceReducer', () => {
  it('ready -> listening with member and place', () => {
    const s = run([
      {
        type: 'ready',
        sessionId: 's',
        member: { name: 'Dev', role: 'owner' },
        place: { key: 'p1', nickname: 'Silchar flat' },
      },
    ]);
    expect(s.connected).toBe(true);
    expect(s.orb).toBe('listening');
    expect(s.member?.name).toBe('Dev');
    expect(s.place?.nickname).toBe('Silchar flat');
  });

  it('state drives the orb', () => {
    for (const value of ['listening', 'thinking', 'speaking'] as const)
      expect(run([{ type: 'state', value }]).orb).toBe(value);
  });

  it('heard and say set captions', () => {
    const s = run([
      { type: 'heard', text: 'দই লাগবে', lang: 'bn-IN', final: true },
      { type: 'say', turnId: 't1', text: 'Dui packet, ek sho bish taka.' },
    ]);
    expect(s.heard).toEqual({ text: 'দই লাগবে', lang: 'bn-IN' });
    expect(s.say).toEqual({ turnId: 't1', text: 'Dui packet, ek sho bish taka.' });
  });

  it('audio_start/audio_end track the segment being received', () => {
    const started = run([{ type: 'audio_start', turnId: 't1', segment: 0, codec: 'mp3', sampleRate: 24000 }]);
    expect(started.receiving).toEqual({ turnId: 't1', segment: 0 });
    expect(voiceReducer(started, { type: 'audio_end', turnId: 't1', segment: 0 }).receiving).toBeNull();
    // A stale audio_end for another segment is ignored.
    expect(voiceReducer(started, { type: 'audio_end', turnId: 't1', segment: 1 })).toBe(started);
  });

  it('stop_audio clears playback state and the spoken caption', () => {
    const s = run([
      { type: 'say', turnId: 't1', text: 'hello' },
      { type: 'audio_start', turnId: 't1', segment: 0 },
      { type: 'stop_audio', turnId: 't1' },
    ]);
    expect(s.receiving).toBeNull();
    expect(s.say).toBeNull();
  });

  it('cart stores the quote and removed lines; a different cart clears the decision', () => {
    const withCart = run([{ type: 'cart', quote, removed: [{ name: 'Ice cream', qty: 1 }] }]);
    expect(withCart.cart?.quote.total).toBe(12500);
    expect(withCart.cart?.removed).toEqual([{ name: 'Ice cream', qty: 1 }]);
    const decided = voiceReducer(withCart, {
      type: 'decision',
      verdict: 'HOLD',
      quoteHash: 'h1',
      reasons: [],
      needsPin: true,
    });
    const refreshed = voiceReducer(decided, { type: 'cart', quote: { ...quote, hash: 'h2', total: 13000 } });
    expect(refreshed.decision).toBeNull();
    const sameHash = voiceReducer(decided, { type: 'cart', quote });
    expect(sameHash.decision?.needsPin).toBe(true);
  });

  it('decision keeps needsPin, and treats needsBiometric the same', () => {
    const a = run([
      {
        type: 'decision',
        verdict: 'HOLD',
        quoteHash: 'h1',
        reasons: [{ rule: 'per_order_ceiling', detail: 'x' }],
        needsPin: true,
        spokenConfirmation: false,
      },
    ]);
    expect(a.decision).toMatchObject({ verdict: 'HOLD', needsPin: true, quoteHash: 'h1', spokenConfirmation: false });
    const b = run([{ type: 'decision', verdict: 'HOLD', quoteHash: 'h1', needsBiometric: true }]);
    expect(b.decision?.needsPin).toBe(true);
    const c = run([{ type: 'decision', verdict: 'PAY', quoteHash: 'h1' }]);
    expect(c.decision?.needsPin).toBe(false);
  });

  it('order shows success and clears the cart and decision', () => {
    const s = run([
      { type: 'cart', quote },
      { type: 'decision', verdict: 'PAY', quoteHash: 'h1' },
      { type: 'order', supplierOrderId: 'o1', status: 'placed', etaMinutes: 14 },
    ]);
    expect(s.order).toEqual({ supplierOrderId: 'o1', status: 'placed', etaMinutes: 14 });
    expect(s.cart).toBeNull();
    expect(s.decision).toBeNull();
  });

  it('error is recoverable and cleared when listening again', () => {
    const e = run([{ type: 'ready' }, { type: 'error', code: 'stt', message: 'Could not hear that.' }]);
    expect(e.error?.message).toBe('Could not hear that.');
    expect(e.connected).toBe(true);
    expect(voiceReducer(e, { type: 'state', value: 'listening' }).error).toBeNull();
  });

  it('ignores unknown message types', () => {
    const s = run([{ type: 'ready' }]);
    expect(voiceReducer(s, { type: 'brand_new_thing' } as unknown as ServerMessage)).toBe(s);
  });

  it('local events: connecting, interrupt, closed', () => {
    const connecting = run([{ type: 'local/connecting' }]);
    expect(connecting.orb).toBe('connecting');
    const speaking = run([
      { type: 'ready' },
      { type: 'say', turnId: 't', text: 'x' },
      { type: 'state', value: 'speaking' },
    ]);
    const interrupted = voiceReducer(speaking, { type: 'local/interrupt' });
    expect(interrupted.orb).toBe('listening');
    expect(interrupted.say).toBeNull();
    const closed = voiceReducer(speaking, { type: 'local/closed', code: 4409 });
    expect(closed.orb).toBe('off');
    expect(closed.connected).toBe(false);
    expect(closed.error?.message).toMatch(/another device/);
    expect(voiceReducer(speaking, { type: 'local/closed', code: 1000 }).error).toBeNull();
  });

  it('close codes map to messages', () => {
    expect(closeMessage(4401)).toMatch(/signed out/);
    expect(closeMessage(1011)).toMatch(/not available/);
    expect(closeMessage(1000)).toBeNull();
  });
});
