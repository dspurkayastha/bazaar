/** The keypad (DTMF) PIN path, behind its interface, with fakes for the PIN check and the approval service. */
import { describe, expect, it } from 'vitest';
import type { ApprovalOutcome } from '../src/agent/conversation.js';
import type { PinProof, PinVerification } from '../src/auth/pin.js';
import { handleKeypadPin, type KeypadDeps } from '../src/voice/keypad.js';
import { ConversationSession, PIN_WINDOW_MS, canTransition } from '../src/voice/session.js';

const OWNER = { id: 'mem_dev', role: 'owner' as const };
const ADDER = { id: 'mem_p', role: 'adder' as const };
const proof = { memberId: OWNER.id, verifiedAtMs: 0 } as PinProof;
const placed: ApprovalOutcome = {
  decision: { verdict: 'PAY', reasons: [], evaluatedAt: '2026-10-12T14:00:00.000Z' },
  placed: true,
  requote: false,
  order: {
    supplierId: 'instamart',
    supplierOrderId: 'o1',
    quoteId: 'q',
    status: 'placed',
    placedAt: '2026-10-12T14:00:00.000Z',
  },
};

function fakes(verdict: PinVerification) {
  const calls = { verify: [] as string[], approve: [] as { hash: string; factor: unknown }[] };
  let now = 1_000;
  const deps: KeypadDeps = {
    verifyPinForApproval: async (_m, digits) => {
      calls.verify.push(digits);
      return verdict;
    },
    approve: async (hash, _who, factor) => {
      calls.approve.push({ hash, factor });
      return placed;
    },
    clock: () => now,
  };
  return { deps, calls, advance: (ms: number) => (now += ms) };
}

function session(): ConversationSession {
  const s = new ConversationSession('hh', OWNER.id, 0, 600_000);
  s.attach(0);
  s.pinRequest = { quoteHash: 'q'.repeat(64), at: 1_000 };
  return s;
}

describe('keypad PIN approvals', () => {
  it('a right PIN approves the quote the server asked about, with the PIN proof, once', async () => {
    const s = session();
    const { deps, calls } = fakes({ ok: true, proof });
    const r = await handleKeypadPin(s, OWNER, '2468', deps);
    expect(r).toMatchObject({ kind: 'approved', quoteHash: 'q'.repeat(64) });
    expect(calls.approve).toEqual([{ hash: 'q'.repeat(64), factor: { pinProof: proof } }]);
    expect(s.pinRequest).toBeUndefined();
    expect(await handleKeypadPin(s, OWNER, '2468', deps)).toEqual({ kind: 'ignored', reason: 'nothing_pending' });
    expect(calls.verify).toHaveLength(1);
  });

  it('a wrong PIN keeps waiting; a lock ends the request', async () => {
    const s = session();
    const wrong = fakes({ ok: false, reason: 'incorrect', attemptsLeft: 3 });
    expect(await handleKeypadPin(s, OWNER, '0000', wrong.deps)).toEqual({
      kind: 'refused',
      reason: 'incorrect',
      attemptsLeft: 3,
    });
    expect(s.pinRequest).toBeDefined();
    const locking = fakes({
      ok: false,
      reason: 'incorrect',
      attemptsLeft: 0,
      lockedNow: { locked: true, hard: false, until: 'x' },
    });
    expect(await handleKeypadPin(s, OWNER, '0000', locking.deps)).toMatchObject({ kind: 'refused', reason: 'locked' });
    expect(s.pinRequest).toBeUndefined();
    expect(wrong.calls.approve).toHaveLength(0);
  });

  it('refuses without checking the PIN: adder, unauthenticated, expired window', async () => {
    const f = fakes({ ok: true, proof });
    expect(await handleKeypadPin(session(), ADDER, '2468', f.deps)).toEqual({
      kind: 'ignored',
      reason: 'owner_required',
    });
    const s = session();
    s.authenticated = false;
    expect(await handleKeypadPin(s, OWNER, '2468', f.deps)).toEqual({ kind: 'ignored', reason: 'unauthenticated' });
    const late = session();
    f.advance(PIN_WINDOW_MS);
    expect(await handleKeypadPin(late, OWNER, '2468', f.deps)).toEqual({ kind: 'ignored', reason: 'expired' });
    expect(f.calls.verify).toEqual([]);
  });

  it('state machine: awaiting_pin is reachable after a turn and left by keypad, cancel or a new turn', () => {
    expect(canTransition('speaking', 'awaiting_pin')).toBe(true);
    expect(canTransition('thinking', 'awaiting_pin')).toBe(true);
    expect(canTransition('awaiting_pin', 'thinking')).toBe(true);
    expect(canTransition('awaiting_pin', 'listening')).toBe(true);
    expect(canTransition('awaiting_pin', 'speaking')).toBe(false);
    expect(canTransition('listening', 'awaiting_pin')).toBe(false);
    const s = session();
    s.detach(5);
    expect(s.pinRequest).toBeUndefined();
  });
});
