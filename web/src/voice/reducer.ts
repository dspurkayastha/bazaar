import type { CartFee, CartLine } from '../types';

/** Server -> app text messages (docs/VOICE_PROTOCOL.md, plus WEB_API.md `needsPin`). */
export type ServerMessage =
  | {
      type: 'ready';
      sessionId?: string;
      member?: { name: string; role: string };
      place?: { key?: string; nickname?: string };
    }
  | { type: 'state'; value: 'listening' | 'thinking' | 'speaking' }
  | { type: 'heard'; text: string; lang?: string; final?: boolean }
  | { type: 'say'; turnId: string; text: string }
  | { type: 'audio_start'; turnId: string; segment: number; codec?: string; sampleRate?: number }
  | { type: 'audio_end'; turnId: string; segment: number }
  | { type: 'stop_audio'; turnId?: string }
  | {
      type: 'cart';
      quote: VoiceQuote;
      removed?: { name: string; qty?: number }[];
    }
  | {
      type: 'decision';
      verdict: 'PAY' | 'HOLD' | 'BLOCK';
      reasons?: unknown[];
      quoteHash: string;
      needsPin?: boolean;
      needsBiometric?: boolean;
      spokenConfirmation?: boolean;
    }
  | { type: 'order'; supplierOrderId: string; status: string; etaMinutes?: number }
  | { type: 'error'; code: string; message: string };

export interface VoiceQuote {
  hash: string;
  supplier: string;
  place: string | { key?: string; nickname?: string };
  lines: CartLine[];
  fees: CartFee[];
  total: number;
  etaMinutes?: number;
}

/** Local events the UI feeds the reducer. */
export type LocalEvent =
  | { type: 'local/connecting' }
  | { type: 'local/closed'; code: number; reason?: string }
  | { type: 'local/interrupt' }
  | { type: 'local/order'; supplierOrderId: string; status: string; etaMinutes?: number }
  | { type: 'local/cart_done' }
  | { type: 'local/error'; code: string; message: string };

export type VoiceAction = ServerMessage | LocalEvent;

export type Orb = 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export interface VoiceState {
  orb: Orb;
  connected: boolean;
  member: { name: string; role: string } | null;
  place: { key?: string; nickname?: string } | null;
  heard: { text: string; lang?: string } | null;
  say: { turnId: string; text: string } | null;
  /** Segment currently being received (between audio_start and audio_end). */
  receiving: { turnId: string; segment: number } | null;
  cart: { quote: VoiceQuote; removed: { name: string; qty?: number }[] } | null;
  decision: {
    verdict: 'PAY' | 'HOLD' | 'BLOCK';
    reasons: unknown[];
    quoteHash: string;
    needsPin: boolean;
    spokenConfirmation: boolean;
  } | null;
  order: { supplierOrderId: string; status: string; etaMinutes?: number } | null;
  error: { code: string; message: string } | null;
  closeCode: number | null;
}

export const initialVoiceState: VoiceState = {
  orb: 'off',
  connected: false,
  member: null,
  place: null,
  heard: null,
  say: null,
  receiving: null,
  cart: null,
  decision: null,
  order: null,
  error: null,
  closeCode: null,
};

export function closeMessage(code: number): string | null {
  switch (code) {
    case 4401:
      return 'You are signed out. Sign in again to talk to Bazaar.';
    case 4409:
      return 'Bazaar is open on another device, so this one was disconnected.';
    case 1011:
      return 'Voice is not available on the server right now.';
    case 1008:
      return 'The voice connection did not start properly. Try again.';
    case 1000:
    case 1005:
      return null;
    default:
      return 'The voice connection dropped. Tap to talk again.';
  }
}

export function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case 'local/connecting':
      return { ...initialVoiceState, orb: 'connecting' };
    case 'local/closed': {
      const msg = closeMessage(action.code);
      return {
        ...state,
        orb: 'off',
        connected: false,
        receiving: null,
        say: null,
        closeCode: action.code,
        error: msg ? { code: `close_${action.code}`, message: msg } : state.error,
      };
    }
    case 'local/interrupt':
      return { ...state, say: null, receiving: null, orb: state.connected ? 'listening' : state.orb };
    case 'local/order':
      return {
        ...state,
        cart: null,
        decision: null,
        order: { supplierOrderId: action.supplierOrderId, status: action.status, etaMinutes: action.etaMinutes },
      };
    case 'local/cart_done':
      return { ...state, cart: null, decision: null };
    case 'local/error':
      return { ...state, error: { code: action.code, message: action.message } };

    case 'ready':
      return {
        ...state,
        connected: true,
        orb: 'listening',
        member: action.member ?? null,
        place: action.place ?? null,
        error: null,
        closeCode: null,
      };
    case 'state':
      return { ...state, orb: action.value, error: action.value === 'listening' ? null : state.error };
    case 'heard':
      return { ...state, heard: { text: action.text, lang: action.lang } };
    case 'say':
      return { ...state, say: { turnId: action.turnId, text: action.text } };
    case 'audio_start':
      return { ...state, receiving: { turnId: action.turnId, segment: action.segment } };
    case 'audio_end':
      return state.receiving && state.receiving.turnId === action.turnId && state.receiving.segment === action.segment
        ? { ...state, receiving: null }
        : state;
    case 'stop_audio':
      return { ...state, receiving: null, say: null };
    case 'cart':
      return {
        ...state,
        cart: { quote: action.quote, removed: action.removed ?? [] },
        // A new or refreshed cart supersedes any earlier decision/outcome for another hash.
        decision: state.decision && state.decision.quoteHash === action.quote.hash ? state.decision : null,
        order: null,
      };
    case 'decision':
      return {
        ...state,
        decision: {
          verdict: action.verdict,
          reasons: action.reasons ?? [],
          quoteHash: action.quoteHash,
          // Web sessions get needsPin; needsBiometric is the native app's equivalent and is treated the same.
          needsPin: Boolean(action.needsPin ?? action.needsBiometric),
          spokenConfirmation: Boolean(action.spokenConfirmation),
        },
      };
    case 'order':
      return {
        ...state,
        cart: null,
        decision: null,
        order: { supplierOrderId: action.supplierOrderId, status: action.status, etaMinutes: action.etaMinutes },
      };
    case 'error':
      return { ...state, error: { code: action.code, message: action.message } };
    default:
      // Unknown message types are ignored, per the protocol.
      return state;
  }
}
