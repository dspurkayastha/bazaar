/**
 * ConversationSession: one per member. Holds the multi-turn history (capped at ~20 turns, dropped after 10 min idle),
 * the voice state machine, the current place and the held quote waiting for a yes. It outlives a single WebSocket so a
 * quick reconnect keeps the conversation, but every new connection clears the pending confirmation: a yes must answer
 * a question asked on the same authenticated connection.
 *
 * State machine:
 *   idle → listening → thinking → speaking → listening | awaiting_confirmation | awaiting_pin
 *   thinking → listening | awaiting_confirmation | awaiting_pin (nothing to say, or barge-in) ;
 *   speaking → thinking (new turn)
 *   awaiting_confirmation → thinking (next turn) | listening (cancel, timeout)
 *   awaiting_pin → thinking (keypad PIN entered, or the next spoken turn) | listening (cancel) ; any → idle (disconnect)
 * `state` frames to the app only carry listening / thinking / speaking (the awaiting_* states show as listening).
 *
 * awaiting_pin: the held quote is above PIN_REQUIRED_ABOVE_RUPEES, so a spoken yes cannot approve it. The server sent
 * `decision.needsPin`; the web app answers with its PIN pad (POST /api/carts/:quoteHash/approve), a phone call with
 * the keypad (voice/keypad.ts → verifyPinForApproval).
 */
import type { ConversationState, PendingConfirmation, VoiceAgentContext } from '../agent/conversation.js';
import type { LlmMessage } from '../agent/llm.js';
import { newId } from '../core/ids.js';
import type { VoiceLang } from './config.js';

/** How long a keypad PIN may follow the server's needsPin decision. */
export const PIN_WINDOW_MS = 5 * 60_000;

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'awaiting_confirmation' | 'awaiting_pin';

const TRANSITIONS: Record<VoiceState, readonly VoiceState[]> = {
  idle: ['listening'],
  listening: ['thinking', 'idle'],
  thinking: ['speaking', 'listening', 'awaiting_confirmation', 'awaiting_pin', 'idle'],
  speaking: ['listening', 'awaiting_confirmation', 'awaiting_pin', 'thinking', 'idle'],
  awaiting_confirmation: ['thinking', 'listening', 'idle'],
  awaiting_pin: ['thinking', 'listening', 'idle'],
};

export function canTransition(from: VoiceState, to: VoiceState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** What the app sees for a state. */
export function appState(s: VoiceState): 'listening' | 'thinking' | 'speaking' {
  return s === 'thinking' ? 'thinking' : s === 'speaking' ? 'speaking' : 'listening';
}

export class ConversationSession implements ConversationState {
  readonly id = newId('vs');
  authenticated = false;
  turns: LlmMessage[][] = [];
  placeId?: string;
  /** The place the app picked in `hello` (placeHint), restored when the conversation starts over. */
  hintPlaceId?: string;
  pending?: PendingConfirmation;
  /**
   * The held quote the server asked the owner to approve with the PIN (`decision.needsPin`). Unlike `pending` it
   * survives later turns (the owner may talk while finding the keypad); cleared by cancel, a keypad approval, a new
   * connection or its own age (PIN_WINDOW_MS).
   */
  pinRequest?: { quoteHash: string; at: number };
  agent?: VoiceAgentContext;
  /** Reply language for the next turn (from STT, else the app's locale). */
  lang: VoiceLang = 'en-IN';
  private _state: VoiceState = 'idle';
  private lastActive: number;

  constructor(
    readonly householdId: string,
    readonly memberId: string,
    now: number,
    private readonly ttlMs: number,
  ) {
    this.lastActive = now;
  }

  get state(): VoiceState {
    return this._state;
  }

  /** Move to `to`; throws on a transition the machine does not allow (a wiring bug). */
  transition(to: VoiceState): void {
    if (!canTransition(this._state, to)) throw new Error(`voice session: illegal transition ${this._state} → ${to}`);
    this._state = to;
  }

  touch(now: number): void {
    this.lastActive = now;
  }

  expired(now: number): boolean {
    return now - this.lastActive >= this.ttlMs;
  }

  /**
   * Called at the start of every turn: after the TTL of silence the conversation starts over (history, place, carts
   * already shown and any pending confirmation are dropped). Returns true when it reset.
   */
  refresh(now: number): boolean {
    const reset = this.expired(now);
    if (reset) {
      this.turns = [];
      this.pending = undefined;
      this.pinRequest = undefined;
      this.agent = undefined;
      this.placeId = this.hintPlaceId;
    }
    this.touch(now);
    return reset;
  }

  /** A new authenticated connection took the session. */
  attach(now: number): void {
    this.authenticated = true;
    this.pending = undefined;
    this.pinRequest = undefined;
    this._state = 'idle';
    this.touch(now);
  }

  detach(now: number): void {
    this.authenticated = false;
    this.pending = undefined;
    this.pinRequest = undefined;
    this._state = 'idle';
    this.touch(now);
  }
}

/** Sessions by member. A session idle for longer than the TTL is replaced by a fresh one (history dropped). */
export class SessionRegistry {
  private readonly sessions = new Map<string, ConversationSession>();

  constructor(private readonly ttlMs: number) {}

  get(householdId: string, memberId: string, now: number): ConversationSession {
    this.sweep(now);
    const existing = this.sessions.get(memberId);
    if (existing && existing.householdId === householdId && !existing.expired(now)) return existing;
    const fresh = new ConversationSession(householdId, memberId, now, this.ttlMs);
    this.sessions.set(memberId, fresh);
    return fresh;
  }

  /** Drop expired sessions that no connection holds. */
  sweep(now: number): void {
    for (const [k, s] of this.sessions) if (!s.authenticated && s.expired(now)) this.sessions.delete(k);
  }

  get size(): number {
    return this.sessions.size;
  }
}
