import { VoiceSession } from '../voice/session';
import type { ServerMessage, VoiceAction } from '../voice/reducer';
import { isSampleMode } from './mode';

/** What the Talk screen needs from a voice session. */
export interface VoiceLike {
  start(): Promise<void>;
  stop(): void;
  interrupt(): void;
  cancel(): void;
}

type Dispatch = (a: VoiceAction) => void;

const TURN = 'sample-turn-1';

/** [delay in ms since start, what the server would have sent] */
export const SCRIPT: [number, ServerMessage][] = [
  [
    500,
    {
      type: 'ready',
      sessionId: 'sample',
      member: { name: 'Aarav', role: 'owner' },
      place: { key: 'silchar-flat', nickname: 'Silchar flat' },
    },
  ],
  [
    1500,
    {
      type: 'heard',
      text: 'Dudh aar dim shesh hoye gechhe, kal sokal-er jonno order kore dao.',
      lang: 'bn-IN',
      final: true,
    },
  ],
  [2300, { type: 'state', value: 'thinking' }],
  [3600, { type: 'state', value: 'speaking' }],
  [
    3700,
    {
      type: 'say',
      turnId: TURN,
      text: 'Two litres of milk and a dozen eggs for the Silchar flat, 278 rupees with delivery. It is under 500, so a yes is enough.',
    },
  ],
  [
    4200,
    {
      type: 'cart',
      quote: {
        hash: 'sample-voice-1',
        supplier: 'instamart',
        place: { key: 'silchar-flat', nickname: 'Silchar flat' },
        lines: [
          { name: 'Toned milk', label: '1 L', qty: 2, lineTotal: 15200 },
          { name: 'Eggs', label: '12 pack', qty: 1, lineTotal: 9600 },
        ],
        fees: [
          { label: 'Handling', amount: 500 },
          { label: 'Delivery', amount: 2500 },
        ],
        total: 27800,
        etaMinutes: 16,
      },
    },
  ],
  [4300, { type: 'decision', verdict: 'HOLD', reasons: ['role'], quoteHash: 'sample-voice-1', needsPin: false }],
  [8200, { type: 'state', value: 'listening' }],
];

/** Talk in preview mode: the orb and captions play a fixed exchange. No microphone, no socket. */
export class SampleVoiceSession implements VoiceLike {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private closed = false;

  constructor(private readonly dispatch: Dispatch) {}

  async start(): Promise<void> {
    this.dispatch({ type: 'local/connecting' });
    for (const [at, msg] of SCRIPT) {
      this.timers.push(
        setTimeout(() => {
          if (!this.closed) this.dispatch(msg);
        }, at),
      );
    }
  }

  interrupt(): void {
    this.clear();
    this.dispatch({ type: 'local/interrupt' });
  }

  cancel(): void {
    /* nothing is running server side */
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.clear();
    this.dispatch({ type: 'local/closed', code: 1000 });
  }

  private clear(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
}

/** The one place Talk asks for a session: the scripted one in preview mode, the real one otherwise. */
export function createVoiceSession(dispatch: Dispatch): VoiceLike {
  return isSampleMode() ? new SampleVoiceSession(dispatch) : new VoiceSession(dispatch);
}
