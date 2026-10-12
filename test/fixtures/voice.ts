/** Voice test helpers: a streaming scripted LLM, a /voice client, and a gateway wired to fake Sarvam servers. */
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { LlmRequest, LlmResponse } from '../../src/agent/llm.js';
import type { Store } from '../../src/agent/store.js';
import type { ApiDeps } from '../../src/api/http.js';
import { buildServer } from '../../src/api/server.js';
import type { KeypadSource } from '../../src/voice/keypad.js';
import type { VoiceOptions } from '../../src/voice/route.js';
import type { Supplier } from '../../src/core/types.js';
import type { VoiceConfig } from '../../src/voice/config.js';
import { FillerCache } from '../../src/voice/fillers.js';
import { SessionRegistry } from '../../src/voice/session.js';
import { ScriptedLlm, type Step } from './llm.js';
import { FakeStt, FakeTts, sleep, until, type FakeTtsOptions } from './sarvam.js';

/** ScriptedLlm that also streams: text blocks are emitted in `chunk`-char pieces, `delayMs` apart; honours abort. */
export class StreamingLlm extends ScriptedLlm {
  /** performance.now() when each stream() call resolved. */
  readonly streamEnds: number[] = [];
  aborted = 0;

  constructor(
    steps: Step[],
    private readonly opts: { chunk?: number; delayMs?: number } = {},
  ) {
    super(steps);
  }

  async stream(req: LlmRequest, onText: (delta: string) => void): Promise<LlmResponse> {
    const res = await this.create(req);
    const chunk = this.opts.chunk ?? 8;
    for (const b of res.content) {
      if (b.type !== 'text') continue;
      for (let i = 0; i < b.text.length; i += chunk) {
        if (this.opts.delayMs) await sleep(this.opts.delayMs);
        if (req.signal?.aborted) {
          this.aborted++;
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        onText(b.text.slice(i, i + chunk));
      }
    }
    this.streamEnds.push(performance.now());
    return res;
  }
}

export type Frame = { kind: 'json'; msg: Record<string, unknown> } | { kind: 'binary'; data: Buffer };

/** A phone keypad, as the telephony adapter will provide it: the test "types" digits. */
export class FakeKeypad implements KeypadSource {
  private handlers: ((digits: string) => void)[] = [];

  onDigits(handler: (digits: string) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  type(digits: string): void {
    for (const h of this.handlers) h(digits);
  }

  get attached(): number {
    return this.handlers.length;
  }
}

export class VoiceClient {
  readonly frames: Frame[] = [];
  closeCode?: number;
  closeReason?: string;
  readonly opened: Promise<void>;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.frames.push(isBinary ? { kind: 'binary', data: buf } : { kind: 'json', msg: JSON.parse(buf.toString()) });
    });
    ws.on('close', (code, reason) => {
      this.closeCode = code;
      this.closeReason = reason.toString();
    });
    this.opened = new Promise((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
  }

  static connect(url: string, token?: string): VoiceClient {
    return new VoiceClient(new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : {}));
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  pcm(bytes = 640): void {
    this.ws.send(Buffer.alloc(bytes, 1), { binary: true });
  }

  messages(type?: string): Record<string, unknown>[] {
    return this.frames.flatMap((f) => (f.kind === 'json' && (!type || f.msg.type === type) ? [f.msg] : []));
  }

  /** Compact trace: message types, binary as "bin", state frames as "state:<value>". */
  trace(): string[] {
    return this.frames.map((f) =>
      f.kind === 'binary' ? 'bin' : f.msg.type === 'state' ? `state:${String(f.msg.value)}` : String(f.msg.type),
    );
  }

  async waitFor(type: string, pred: (m: Record<string, unknown>) => boolean = () => true, timeoutMs = 3000) {
    await until(() => this.messages(type).some(pred), timeoutMs, `${type} message`);
    return this.messages(type).find(pred)!;
  }

  async waitClosed(timeoutMs = 3000): Promise<number> {
    await until(() => this.closeCode !== undefined, timeoutMs, 'close');
    return this.closeCode!;
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
  }
}

export interface VoiceHarness {
  app: FastifyInstance;
  url: string;
  stt: FakeStt;
  tts: FakeTts;
  fillers: FillerCache;
  sessions: SessionRegistry;
  logs: Record<string, unknown>[];
  stop(): Promise<void>;
}

export function testVoiceConfig(stt: FakeStt, tts: FakeTts, over: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    sarvam: {
      apiKey: 'sarvam-test-key',
      sttUrl: stt.url,
      ttsUrl: tts.url,
      sttModel: 'saaras:v4',
      sttMode: 'codemix',
      sttLanguage: 'unknown',
      highVadSensitivity: false,
      ttsModel: 'bulbul:v3',
      speakers: { 'bn-IN': 'shubh', 'hi-IN': 'shubh', 'en-IN': 'shubh' },
      pace: 1.05,
    },
    confirmWindowMs: 90_000,
    fillerAfterMs: 1_200,
    sessionTtlMs: 10 * 60_000,
    maxTurns: 20,
    ...over,
  };
}

export async function startVoice(args: {
  store: Store;
  suppliers: Supplier[];
  llm: ScriptedLlm;
  householdId: string;
  now: () => string;
  config?: Partial<VoiceConfig>;
  unconfigured?: boolean;
  tts?: FakeTtsOptions;
  clock?: () => number;
  logLevel?: string;
  /** PIN_REQUIRED_ABOVE_RUPEES in paise; ₹2,000 here so the ₹1,123 test cart can be approved by a spoken yes. */
  pinRequiredAbovePaise?: number;
  keypadFor?: VoiceOptions['keypadFor'];
  web?: ApiDeps['web'];
}): Promise<VoiceHarness> {
  const stt = await FakeStt.start();
  const tts = await FakeTts.start(args.tts);
  const config = testVoiceConfig(stt, tts, args.config);
  if (args.unconfigured) delete config.sarvam;
  const fillers = new FillerCache();
  const sessions = new SessionRegistry(config.sessionTtlMs);
  const logs: Record<string, unknown>[] = [];
  const app = buildServer(
    {
      store: args.store,
      suppliers: args.suppliers,
      llm: args.llm,
      apiToken: 'test-token',
      defaultHouseholdId: args.householdId,
      now: args.now,
      model: 'test-model',
      pinRequiredAbovePaise: args.pinRequiredAbovePaise ?? 200_000,
      ...(args.web ? { web: args.web } : {}),
      voice: {
        config,
        fillers,
        sessions,
        ...(args.clock ? { clock: args.clock } : {}),
        ...(args.keypadFor ? { keypadFor: args.keypadFor } : {}),
      },
    },
    {
      logStream: { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
      logLevel: args.logLevel ?? 'info',
    },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    url: `ws://127.0.0.1:${port}/voice`,
    stt,
    tts,
    fillers,
    sessions,
    logs,
    async stop() {
      await app.close();
      await stt.close();
      await tts.close();
    },
  };
}
