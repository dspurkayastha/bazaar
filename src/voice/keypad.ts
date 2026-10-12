/**
 * Keypad (DTMF) PIN approvals for voice sessions on a phone call. The telephony provider is not chosen yet; its
 * adapter will implement KeypadSource (collect the digits typed after the prompt, up to `#` or a pause) and attach it
 * to the call's VoiceConnection. Everything that decides is here and in the approval service:
 *
 *   - only while the session is `awaiting_pin` for a quote the server itself asked about (decision.needsPin), within
 *     PIN_WINDOW_MS, for an owner on the authenticated connection;
 *   - the digits go to verifyPinForApproval (src/auth/pin.ts: scrypt, lockout, events) — never logged;
 *   - on success, approveQuote with the single-use PinProof: Approval → placeWithGate, which re-reads the live cart.
 */
import type { ApprovalOutcome } from '../agent/conversation.js';
import type { PinProof, PinVerification } from '../auth/pin.js';
import type { Member } from '../core/types.js';
import { PIN_WINDOW_MS, type ConversationSession } from './session.js';

/** Implemented by the telephony adapter. `onDigits` returns an unsubscribe function. */
export interface KeypadSource {
  onDigits(handler: (digits: string) => void): () => void;
}

export interface KeypadDeps {
  verifyPinForApproval(memberId: string, digits: string): Promise<PinVerification>;
  approve(
    quoteHash: string,
    who: { householdId: string; memberId: string },
    factor: { pinProof: PinProof },
  ): Promise<ApprovalOutcome>;
  /** Wall clock, ms. */
  clock(): number;
}

export type KeypadResult =
  | { kind: 'ignored'; reason: 'nothing_pending' | 'expired' | 'owner_required' | 'unauthenticated' }
  | { kind: 'refused'; reason: 'incorrect' | 'locked' | 'not_set' | 'invalid'; attemptsLeft?: number; hard?: boolean }
  | { kind: 'approved'; quoteHash: string; outcome: ApprovalOutcome };

export async function handleKeypadPin(
  session: ConversationSession,
  member: Pick<Member, 'id' | 'role'>,
  digits: string,
  deps: KeypadDeps,
): Promise<KeypadResult> {
  if (member.role !== 'owner') return { kind: 'ignored', reason: 'owner_required' };
  if (!session.authenticated) return { kind: 'ignored', reason: 'unauthenticated' };
  const asked = session.pinRequest;
  if (!asked) return { kind: 'ignored', reason: 'nothing_pending' };
  if (deps.clock() - asked.at >= PIN_WINDOW_MS) {
    session.pinRequest = undefined;
    return { kind: 'ignored', reason: 'expired' };
  }
  const v = await deps.verifyPinForApproval(member.id, digits);
  if (!v.ok) {
    if (v.reason === 'incorrect') {
      if (v.lockedNow?.locked) {
        session.pinRequest = undefined;
        return { kind: 'refused', reason: 'locked', hard: v.lockedNow.hard };
      }
      return { kind: 'refused', reason: 'incorrect', attemptsLeft: v.attemptsLeft };
    }
    if (v.reason === 'locked') {
      session.pinRequest = undefined;
      return { kind: 'refused', reason: 'locked', hard: v.lock.hard };
    }
    return { kind: 'refused', reason: v.reason };
  }
  session.pinRequest = undefined;
  session.pending = undefined;
  const outcome = await deps.approve(
    asked.quoteHash,
    { householdId: session.householdId, memberId: member.id },
    { pinProof: v.proof },
  );
  return { kind: 'approved', quoteHash: asked.quoteHash, outcome };
}
