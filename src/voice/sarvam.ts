/**
 * Sarvam streaming clients over `ws`: SttStream (saaras:v4, PCM in → transcripts and VAD events out) and TtsStream
 * (bulbul, text in → MP3 chunks out). Both take an injectable WebSocket factory so tests run against fake servers on
 * localhost, reconnect lazily after an idle close, and keep simple latency metrics.
 *
 * Every error frame and every unexpected close or HTTP refusal from Sarvam is logged VERBATIM (`raw`), so a field
 * that differs from the docs at runtime can be fixed in one line. The API key is sent only as the
 * `Api-Subscription-Key` header and never logged.
 */
import WebSocket from 'ws';
import type { SarvamConfig, SttMode, TtsModel } from './config.js';
import { STT_SAMPLE_RATE, TTS_SAMPLE_RATE } from './config.js';

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocket;

export const defaultWebSocketFactory: WebSocketFactory = (url, headers) => new WebSocket(url, { headers });

export type VoiceLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type VoiceLog = (level: VoiceLogLevel, event: string, data?: Record<string, unknown>) => void;
const noLog: VoiceLog = () => undefined;

export interface SarvamClientOptions {
  factory?: WebSocketFactory;
  log?: VoiceLog;
  /** Monotonic ms clock (performance.now by default). */
  clock?: () => number;
}

function rawText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function parse(raw: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const optNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;

/** Open a socket and resolve once it is open; reject (with Sarvam's own words logged) if it is refused. */
function openSocket(
  factory: WebSocketFactory,
  url: string,
  apiKey: string,
  log: VoiceLog,
  what: 'stt' | 'tts',
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = factory(url, { 'Api-Subscription-Key': apiKey });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const fail = (err: Error) => {
      ws.removeAllListeners('open');
      reject(err);
    };
    ws.once('open', () => {
      ws.removeListener('error', fail);
      resolve(ws);
    });
    ws.once('error', fail);
    ws.once('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').slice(0, 2000);
        log('error', `sarvam_${what}_refused`, { status: res.statusCode, raw });
        fail(new SarvamError(`Sarvam ${what} refused the connection: HTTP ${res.statusCode} ${raw}`, res.statusCode));
      });
    });
  });
}

export class SarvamError extends Error {
  constructor(
    message: string,
    readonly code?: unknown,
    readonly raw?: string,
  ) {
    super(message);
    this.name = 'SarvamError';
  }
}

// ---------------------------------------------------------------- STT

export interface SttTranscript {
  text: string;
  languageCode?: string;
  languageProbability?: number;
  requestId?: string;
  audioDurationS?: number;
  /** Sarvam's own processing latency, as reported in metrics (seconds). */
  processingLatencyS?: number;
  /** ms from the END_SPEECH signal (or the last flush) to this transcript; undefined if neither was seen. */
  finalMs?: number;
}

export interface SttHandlers {
  onTranscript(t: SttTranscript): void;
  onSpeechStart?(): void;
  onSpeechEnd?(): void;
  onError?(err: SarvamError): void;
  /** The socket closed without close() being called (idle timeout, server restart). It reopens on the next audio. */
  onClose?(code: number, reason: string): void;
}

export interface SttOptions {
  mode?: SttMode;
  language?: string;
}

export function sttUrl(
  cfg: Pick<SarvamConfig, 'sttUrl' | 'sttModel' | 'sttMode' | 'sttLanguage' | 'highVadSensitivity'>,
  opts: SttOptions = {},
): string {
  const u = new URL(cfg.sttUrl);
  u.searchParams.set('model', cfg.sttModel);
  u.searchParams.set('mode', opts.mode ?? cfg.sttMode);
  u.searchParams.set('language-code', opts.language ?? cfg.sttLanguage);
  u.searchParams.set('sample_rate', String(STT_SAMPLE_RATE));
  u.searchParams.set('input_audio_codec', 'pcm_s16le');
  u.searchParams.set('vad_signals', 'true');
  u.searchParams.set('high_vad_sensitivity', String(cfg.highVadSensitivity));
  u.searchParams.set('flush_signal', 'true');
  return u.toString();
}

/** Audio held while (re)connecting: 2 s of 16 kHz s16le mono. Older audio is dropped first. */
const MAX_PENDING_BYTES = 2 * STT_SAMPLE_RATE * 2;

export class SttStream {
  private ws?: WebSocket;
  private opening?: Promise<void>;
  private closed = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private speechEndAt?: number;
  private readonly factory: WebSocketFactory;
  private readonly log: VoiceLog;
  private readonly clock: () => number;
  readonly metrics = { connects: 0, transcripts: 0, lastFinalMs: undefined as number | undefined, bytesSent: 0 };

  constructor(
    private readonly cfg: SarvamConfig,
    private readonly handlers: SttHandlers,
    opts: SarvamClientOptions & SttOptions = {},
  ) {
    this.factory = opts.factory ?? defaultWebSocketFactory;
    this.log = opts.log ?? noLog;
    this.clock = opts.clock ?? (() => performance.now());
    this.url = sttUrl(cfg, opts);
  }

  readonly url: string;

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Connect (idempotent). Rejects if Sarvam refuses; the refusal is logged verbatim. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('stt stream closed'));
    if (this.open) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = openSocket(this.factory, this.url, this.cfg.apiKey, this.log, 'stt')
      .then((ws) => {
        this.metrics.connects++;
        if (this.closed) {
          ws.close(1000);
          return;
        }
        this.ws = ws;
        ws.on('message', (data) => this.onMessage(rawText(data)));
        ws.on('error', (err) => this.log('warn', 'sarvam_stt_socket_error', { message: err.message }));
        ws.on('close', (code, reason) => {
          if (this.ws === ws) this.ws = undefined;
          if (this.closed) return;
          const r = reason.toString('utf8');
          this.log(code === 1000 ? 'info' : 'warn', 'sarvam_stt_closed', { code, raw: r });
          this.handlers.onClose?.(code, r);
        });
        this.drain();
      })
      .finally(() => {
        this.opening = undefined;
      });
    return this.opening;
  }

  /** Raw PCM s16le 16 kHz mono. Buffered while (re)connecting; reconnects after an idle close. */
  sendAudio(pcm: Buffer): void {
    if (this.closed || pcm.length === 0) return;
    if (this.open && this.pending.length === 0) {
      this.write(pcm);
      return;
    }
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1) {
      this.pendingBytes -= this.pending.shift()!.length;
    }
    if (!this.open && !this.opening) {
      this.connect().catch((err: Error) => {
        this.handlers.onError?.(err instanceof SarvamError ? err : new SarvamError(err.message));
      });
    }
  }

  /** Ask Sarvam to finalise what it has heard so far (flush_signal=true). */
  flush(): void {
    if (!this.open) return;
    this.speechEndAt ??= this.clock();
    this.ws!.send(JSON.stringify({ type: 'flush' }));
  }

  close(): void {
    this.closed = true;
    this.pending = [];
    this.pendingBytes = 0;
    const ws = this.ws;
    this.ws = undefined;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000);
  }

  private drain(): void {
    if (!this.open) return;
    const chunks = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const c of chunks) this.write(c);
  }

  private write(pcm: Buffer): void {
    this.metrics.bytesSent += pcm.length;
    // With input_audio_codec=pcm_s16le the data is raw PCM, base64; `encoding` is what the docs ask for.
    this.ws!.send(
      JSON.stringify({
        audio: { data: pcm.toString('base64'), sample_rate: String(STT_SAMPLE_RATE), encoding: 'audio/wav' },
      }),
    );
  }

  private onMessage(raw: string): void {
    const msg = parse(raw);
    if (!msg) {
      this.log('warn', 'sarvam_stt_unparsed', { raw: raw.slice(0, 2000) });
      return;
    }
    const data = rec(msg.data);
    switch (msg.type) {
      case 'data': {
        const text = (optStr(data.transcript) ?? '').trim();
        const metrics = rec(data.metrics);
        const finalMs = this.speechEndAt !== undefined ? Math.round(this.clock() - this.speechEndAt) : undefined;
        this.speechEndAt = undefined;
        if (text === '') {
          this.log('debug', 'sarvam_stt_empty', {});
          return;
        }
        this.metrics.transcripts++;
        this.metrics.lastFinalMs = finalMs;
        const languageCode = optStr(data.language_code);
        const languageProbability = optNum(data.language_probability);
        const requestId = optStr(data.request_id);
        const audioDurationS = optNum(metrics.audio_duration);
        const processingLatencyS = optNum(metrics.processing_latency);
        this.handlers.onTranscript({
          text,
          ...(languageCode !== undefined ? { languageCode } : {}),
          ...(languageProbability !== undefined ? { languageProbability } : {}),
          ...(requestId !== undefined ? { requestId } : {}),
          ...(audioDurationS !== undefined ? { audioDurationS } : {}),
          ...(processingLatencyS !== undefined ? { processingLatencyS } : {}),
          ...(finalMs !== undefined ? { finalMs } : {}),
        });
        return;
      }
      case 'events': {
        const signal = optStr(data.signal_type);
        if (signal === 'START_SPEECH') {
          this.speechEndAt = undefined;
          this.handlers.onSpeechStart?.();
        } else if (signal === 'END_SPEECH') {
          this.speechEndAt = this.clock();
          this.handlers.onSpeechEnd?.();
        } else this.log('debug', 'sarvam_stt_event', { raw: raw.slice(0, 500) });
        return;
      }
      case 'error': {
        this.log('error', 'sarvam_stt_error', { raw: raw.slice(0, 2000) });
        const message = optStr(data.error) ?? optStr(data.message) ?? raw.slice(0, 300);
        this.handlers.onError?.(new SarvamError(`Sarvam STT: ${message}`, data.code, raw));
        return;
      }
      default:
        this.log('debug', 'sarvam_stt_unknown', { raw: raw.slice(0, 500) });
    }
  }
}

// ---------------------------------------------------------------- TTS

export interface TtsSettings {
  apiKey: string;
  ttsUrl: string;
  model: TtsModel;
  languageCode: string;
  speaker: string;
  pace?: number;
}

export function ttsUrl(base: string, model: TtsModel): string {
  const u = new URL(base);
  u.searchParams.set('model', model);
  u.searchParams.set('send_completion_event', 'true');
  return u.toString();
}

export function ttsConfigMessage(s: TtsSettings) {
  return {
    type: 'config',
    data: {
      model: s.model,
      language_code: s.languageCode,
      speaker: s.speaker,
      output_audio_codec: 'mp3',
      speech_sample_rate: String(TTS_SAMPLE_RATE),
      pace: s.pace ?? 1.05,
      min_buffer_size: 50,
      max_chunk_length: 150,
    },
  };
}

export const MAX_TTS_TEXT = 2500;
/** A segment with no audio or completion event for this long fails (the socket is dropped and reopened next time). */
const SEGMENT_TIMEOUT_MS = 20_000;

/** Tiny async queue: push values, end or fail, iterate. */
class Channel<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private failWaiters: ((e: Error) => void)[] = [];
  private done = false;
  private error?: Error;

  push(v: T): void {
    if (this.done) return;
    const w = this.waiters.shift();
    this.failWaiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  end(): void {
    if (this.done) return;
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
    this.failWaiters = [];
  }
  fail(e: Error): void {
    if (this.done) return;
    this.done = true;
    this.error = e;
    for (const f of this.failWaiters.splice(0)) f(e);
    this.waiters = [];
  }
  get finished(): boolean {
    return this.done;
  }
  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.done) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      this.failWaiters.push(reject);
    });
  }
}

/**
 * One Bulbul streaming socket for one language + speaker. `synthesize()` calls run one at a time, in order:
 * text → flush → MP3 chunks until the completion event. The socket opens lazily (config first) and reopens after an
 * idle close (Sarvam closes after 60 s without traffic).
 */
export class TtsStream {
  private ws?: WebSocket;
  private opening?: Promise<WebSocket>;
  private current?: Channel<Buffer>;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly factory: WebSocketFactory;
  private readonly log: VoiceLog;
  private readonly clock: () => number;
  readonly url: string;
  readonly metrics = { connects: 0, segments: 0, lastFirstAudioMs: undefined as number | undefined };

  constructor(
    readonly settings: TtsSettings,
    opts: SarvamClientOptions = {},
  ) {
    this.factory = opts.factory ?? defaultWebSocketFactory;
    this.log = opts.log ?? noLog;
    this.clock = opts.clock ?? (() => performance.now());
    this.url = ttsUrl(settings.ttsUrl, settings.model);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** MP3 chunks for `text`, in order. Ends on Sarvam's completion event; throws on a Sarvam error. */
  synthesize(text: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    return this.segment(text.trim().slice(0, MAX_TTS_TEXT), signal);
  }

  private async *segment(body: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    // Serialise: a segment starts only after the previous one finished (ordered by first iteration).
    let done!: () => void;
    const turn = new Promise<void>((r) => (done = r));
    const previous = this.chain;
    this.chain = previous.then(() => turn);
    try {
      await previous;
      if (this.closed) throw new SarvamError('tts stream closed');
      if (signal?.aborted || body === '') return;
      const ws = await this.ensureOpen();
      const ch = new Channel<Buffer>();
      this.current = ch;
      const started = this.clock();
      let first = true;
      let cut = false;
      let timer: NodeJS.Timeout | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.log('warn', 'sarvam_tts_timeout', { ms: SEGMENT_TIMEOUT_MS });
          ch.fail(new SarvamError('Sarvam TTS: no audio or completion event in time'));
          this.drop();
        }, SEGMENT_TIMEOUT_MS);
      };
      const onAbort = () => {
        cut = true;
        ch.end();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      arm();
      try {
        ws.send(JSON.stringify({ type: 'text', data: { text: body } }));
        ws.send(JSON.stringify({ type: 'flush' }));
        for (;;) {
          const r = await ch.next();
          if (r.done) break;
          arm();
          if (first) {
            first = false;
            this.metrics.lastFirstAudioMs = Math.round(this.clock() - started);
          }
          yield r.value;
        }
        if (!cut) this.metrics.segments++;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (this.current === ch) this.current = undefined;
        // Aborted, or the consumer stopped, mid-segment: the socket still carries this segment's audio. Drop it so
        // the next segment cannot receive stale chunks (the next call reconnects).
        if (cut || !ch.finished) {
          ch.end();
          this.drop();
        }
      }
    } finally {
      done();
    }
  }

  /** Keepalive (`ping`) for an open socket; Sarvam closes after 60 s idle. */
  ping(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping' }));
  }

  close(): void {
    this.closed = true;
    this.current?.end();
    this.drop();
  }

  private drop(): void {
    const ws = this.ws;
    this.ws = undefined;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000);
  }

  private ensureOpen(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.opening) return this.opening;
    this.opening = openSocket(this.factory, this.url, this.settings.apiKey, this.log, 'tts')
      .then((ws) => {
        this.metrics.connects++;
        this.ws = ws;
        ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
        ws.on('error', (err) => this.log('warn', 'sarvam_tts_socket_error', { message: err.message }));
        ws.on('close', (code, reason) => {
          if (this.ws === ws) this.ws = undefined;
          const r = reason.toString('utf8');
          if (!this.closed && code !== 1000) this.log('warn', 'sarvam_tts_closed', { code, raw: r });
          // A close mid-segment ends it with whatever arrived; an error frame (if any) already failed it.
          if (this.current && !this.current.finished) {
            this.current.fail(new SarvamError(`Sarvam TTS closed mid-segment: ${code} ${r}`, code));
          }
        });
        ws.send(JSON.stringify(ttsConfigMessage(this.settings)));
        return ws;
      })
      .finally(() => {
        this.opening = undefined;
      });
    return this.opening;
  }

  private onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      // The docs describe JSON audio frames; accept raw MP3 too in case the server sends it that way.
      this.current?.push(Buffer.isBuffer(data) ? data : Buffer.from(rawText(data), 'utf8'));
      return;
    }
    const raw = rawText(data);
    const msg = parse(raw);
    if (!msg) {
      this.log('warn', 'sarvam_tts_unparsed', { raw: raw.slice(0, 2000) });
      return;
    }
    const d = rec(msg.data);
    switch (msg.type) {
      case 'audio': {
        const b64 = optStr(d.audio);
        if (b64) this.current?.push(Buffer.from(b64, 'base64'));
        return;
      }
      case 'event': {
        if (d.event_type === 'final') this.current?.end();
        else this.log('debug', 'sarvam_tts_event', { raw: raw.slice(0, 500) });
        return;
      }
      case 'error': {
        const message = optStr(d.message) ?? optStr(d.error) ?? raw.slice(0, 300);
        this.log('error', 'sarvam_tts_error', { raw: raw.slice(0, 2000) });
        if (/speaker/i.test(message)) {
          this.log('error', 'sarvam_tts_speaker_rejected', {
            speaker: this.settings.speaker,
            languageCode: this.settings.languageCode,
            model: this.settings.model,
            hint: `Sarvam rejected speaker "${this.settings.speaker}" for ${this.settings.languageCode} on ${this.settings.model}; set SARVAM_SPEAKER_${this.settings.languageCode.slice(0, 2).toUpperCase()} to a speaker this model supports`,
            raw: raw.slice(0, 2000),
          });
        }
        this.current?.fail(new SarvamError(`Sarvam TTS: ${message}`, d.code, raw));
        return;
      }
      case 'pong':
        return;
      default:
        this.log('debug', 'sarvam_tts_unknown', { raw: raw.slice(0, 500) });
    }
  }
}

/** Collect a whole synthesis into one buffer (fillers, the CLI). */
export async function synthesizeAll(tts: TtsStream, text: string, signal?: AbortSignal): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of tts.synthesize(text, signal)) parts.push(c);
  return Buffer.concat(parts);
}
