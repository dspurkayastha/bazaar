/**
 * Fake Sarvam STT and TTS WebSocket servers on 127.0.0.1 (random ports). No network beyond loopback.
 * They speak the message shapes in src/voice/sarvam.ts (as documented by Sarvam) and record what they receive.
 */
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(pred: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

interface Conn {
  ws: WebSocket;
  url: URL;
  headers: IncomingMessage['headers'];
  received: Record<string, unknown>[];
  closed: boolean;
}

abstract class FakeServer {
  protected wss!: WebSocketServer;
  readonly conns: Conn[] = [];
  port = 0;

  protected async listen(): Promise<void> {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => this.wss.once('listening', () => r()));
    this.port = (this.wss.address() as AddressInfo).port;
    this.wss.on('connection', (ws, req) => {
      const conn: Conn = {
        ws,
        url: new URL(req.url ?? '/', `ws://127.0.0.1:${this.port}`),
        headers: req.headers,
        received: [],
        closed: false,
      };
      this.conns.push(conn);
      ws.on('close', () => (conn.closed = true));
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        conn.received.push(msg);
        this.onMessage(conn, msg);
      });
    });
  }

  protected abstract onMessage(conn: Conn, msg: Record<string, unknown>): void;

  get last(): Conn {
    const c = this.conns[this.conns.length - 1];
    if (!c) throw new Error('no connection yet');
    return c;
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

export class FakeStt extends FakeServer {
  get url(): string {
    return `ws://127.0.0.1:${this.port}/speech-to-text/ws`;
  }

  static async start(): Promise<FakeStt> {
    const s = new FakeStt();
    await s.listen();
    return s;
  }

  protected onMessage(): void {}

  /** Audio frames received on the latest connection (decoded PCM). */
  audio(conn: Conn = this.last): Buffer {
    return Buffer.concat(
      conn.received.filter((m) => m.audio).map((m) => Buffer.from((m.audio as { data: string }).data, 'base64')),
    );
  }

  send(msg: unknown, conn: Conn = this.last): void {
    conn.ws.send(JSON.stringify(msg));
  }

  speechStart(): void {
    this.send({ type: 'events', data: { signal_type: 'START_SPEECH', occured_at: Date.now() / 1000 } });
  }

  speechEnd(): void {
    this.send({ type: 'events', data: { signal_type: 'END_SPEECH', occured_at: Date.now() / 1000 } });
  }

  transcript(text: string, lang = 'bn-IN', probability = 0.93): void {
    this.send({
      type: 'data',
      data: {
        request_id: 'req_fake',
        transcript: text,
        language_code: lang,
        language_probability: probability,
        metrics: { audio_duration: 1.2, processing_latency: 0.21 },
      },
    });
  }

  /** END_SPEECH then the transcript (what a finished utterance looks like). */
  utterance(text: string, lang = 'bn-IN'): void {
    this.speechStart();
    this.speechEnd();
    this.transcript(text, lang);
  }
}

export interface FakeTtsOptions {
  /** Audio chunks per segment (default 2). */
  chunks?: number;
  /** Delay between chunks, ms (default 0). */
  chunkDelayMs?: number;
  /** Reply to config with this error frame instead (e.g. a rejected speaker). */
  configError?: { message: string; code?: string };
}

/** Per flush: `chunks` audio frames carrying "MP3:<text>#<i>", then the final event. */
export class FakeTts extends FakeServer {
  /** Every text frame received, across connections, with the time it arrived. */
  readonly texts: { text: string; at: number }[] = [];

  constructor(readonly opts: FakeTtsOptions = {}) {
    super();
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/text-to-speech/ws`;
  }

  static async start(opts: FakeTtsOptions = {}): Promise<FakeTts> {
    const s = new FakeTts(opts);
    await s.listen();
    return s;
  }

  protected onMessage(conn: Conn, msg: Record<string, unknown>): void {
    const pending = (conn as Conn & { text?: string }).text;
    if (msg.type === 'config' && this.opts.configError) {
      conn.ws.send(JSON.stringify({ type: 'error', data: this.opts.configError }));
      return;
    }
    if (msg.type === 'text') {
      const text = (msg.data as { text: string }).text;
      (conn as Conn & { text?: string }).text = text;
      this.texts.push({ text, at: performance.now() });
      return;
    }
    if (msg.type === 'flush' && pending !== undefined) {
      (conn as Conn & { text?: string }).text = undefined;
      void this.speak(conn, pending);
    }
  }

  private async speak(conn: Conn, text: string): Promise<void> {
    const n = this.opts.chunks ?? 2;
    for (let i = 0; i < n; i++) {
      if (this.opts.chunkDelayMs) await sleep(this.opts.chunkDelayMs);
      if (conn.ws.readyState !== WebSocket.OPEN) return;
      conn.ws.send(
        JSON.stringify({
          type: 'audio',
          data: {
            content_type: 'audio/mp3',
            audio: Buffer.from(`MP3:${text}#${i}`).toString('base64'),
            request_id: 'r',
          },
        }),
      );
    }
    if (conn.ws.readyState === WebSocket.OPEN)
      conn.ws.send(JSON.stringify({ type: 'event', data: { event_type: 'final' } }));
  }
}
