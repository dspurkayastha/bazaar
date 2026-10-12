/**
 * One live /voice connection (docs/VOICE_PROTOCOL.md): app mic PCM → Sarvam STT → a conversation turn → sentence by
 * sentence → Sarvam TTS → MP3 frames back to the app, plus captions, cart, decision and order messages.
 *
 *   - Turns run one at a time. A new final transcript while a turn is in flight supersedes it (its model call is
 *     aborted and its audio stopped; tool calls already running finish silently and are recorded).
 *   - Barge-in: START_SPEECH from STT while Bazaar is speaking, or `interrupt` from the app → `stop_audio`, the TTS
 *     socket is closed, the model call is aborted. build_cart / propose_checkout / confirm_pending_order are never
 *     aborted.
 *   - Fillers: when a tool call has run for `fillerAfterMs` (1.2 s) and nothing has been said yet, one cached filler
 *     in the turn's language is played.
 *   - Approvals: spoken yes → conversation.ts (confirm_pending_order, rules in code). Face ID → `approve` here, only
 *     for the hash the server itself asked about (needsBiometric), only for an owner on this authenticated
 *     connection. Both go through the /approve path (approveQuote → placeWithGate).
 */
import type WebSocket from 'ws';
import {
  noteTurn,
  phrase,
  runConversationTurn,
  type ApprovalOutcome,
  type ConversationDeps,
  type TurnHooks,
  type TurnResult,
} from '../agent/conversation.js';
import { makeRequest } from '../agent/loop.js';
import { scrub, type VoiceTurnTelemetry } from '../agent/trace.js';
import type { AuthedMember } from '../api/auth.js';
import type { ApiDeps } from '../api/http.js';
import type { Household, Member, Place } from '../core/types.js';
import { normalisePhrase, resolvePlace } from '../places/resolver.js';
import { TTS_SAMPLE_RATE, voiceLang, type SarvamConfig, type VoiceConfig, type VoiceLang } from './config.js';
import { FillerCache, type Filler } from './fillers.js';
import {
  SttStream,
  TtsStream,
  synthesizeAll,
  type SttTranscript,
  type VoiceLog,
  type WebSocketFactory,
} from './sarvam.js';
import { SentenceSplitter, splitSentences } from './sentences.js';
import {
  BIOMETRIC_WINDOW_MS,
  appState,
  type ConversationSession,
  type SessionRegistry,
  type VoiceState,
} from './session.js';

export interface VoiceLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface VoiceRuntime {
  api: ApiDeps;
  config: VoiceConfig;
  sarvam: SarvamConfig;
  sessions: SessionRegistry;
  fillers: FillerCache;
  approve: (quoteHash: string, who: AuthedMember) => Promise<ApprovalOutcome>;
  wsFactory?: WebSocketFactory;
  /** Wall clock, ms (Date.now): sessions, confirmation window. */
  clock?: () => number;
  /** How long to wait for `hello` (10 s). */
  helloTimeoutMs?: number;
}

const OPEN = 1;
/** Audio held before STT is ready: 1 s. */
const MAX_EARLY_AUDIO = 32_000;

type Item = { kind: 'tts'; text: string } | { kind: 'cached'; filler: Filler };

/** The audio side of one turn: an ordered queue of segments, each `say` → `audio_start` → MP3 → `audio_end`. */
class Speaker {
  private queue: Item[] = [];
  private running?: Promise<void>;
  private segment = 0;
  private stopped = false;
  private audioStarted = false;
  private ttsErrorSent = false;
  private readonly abort = new AbortController();
  firstAudioAt?: number;
  /** The turn's model/tool work is still going (decides speaking → thinking between segments). */
  busy = true;

  constructor(
    private readonly conn: VoiceConnection,
    readonly turnId: string,
    readonly lang: VoiceLang,
  ) {}

  get spoken(): boolean {
    return this.audioStarted || this.queue.length > 0 || this.running !== undefined;
  }

  say(text: string): void {
    if (this.stopped || text.trim() === '') return;
    this.queue.push({ kind: 'tts', text });
    this.pump();
  }

  /** Play a cached filler now, only if nothing is queued or playing. */
  filler(f: Filler): boolean {
    if (this.stopped || this.spoken) return false;
    this.queue.push({ kind: 'cached', filler: f });
    this.pump();
    return true;
  }

  async finished(): Promise<void> {
    while (this.running) await this.running;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue = [];
    this.abort.abort();
    if (this.audioStarted) this.conn.send({ type: 'stop_audio', turnId: this.turnId });
    this.conn.dropTts();
  }

  private pump(): void {
    if (this.running) return;
    this.running = (async () => {
      while (this.queue.length > 0 && !this.stopped) await this.play(this.queue.shift()!);
      this.running = undefined;
    })();
  }

  private start(segment: number): void {
    if (!this.audioStarted) {
      this.audioStarted = true;
      this.firstAudioAt = performance.now();
    }
    this.conn.setState('speaking');
    this.conn.send({ type: 'audio_start', turnId: this.turnId, segment, codec: 'mp3', sampleRate: TTS_SAMPLE_RATE });
  }

  private end(segment: number): void {
    this.conn.send({ type: 'audio_end', turnId: this.turnId, segment });
    if (this.busy && this.queue.length === 0 && !this.stopped) this.conn.setState('thinking');
  }

  private async play(item: Item): Promise<void> {
    const segment = this.segment++;
    const text = item.kind === 'tts' ? item.text : item.filler.text;
    this.conn.send({ type: 'say', turnId: this.turnId, text });
    if (item.kind === 'cached') {
      this.start(segment);
      this.conn.sendBinary(item.filler.audio);
      this.end(segment);
      return;
    }
    let started = false;
    try {
      for await (const chunk of this.conn.tts(this.lang).synthesize(text, this.abort.signal)) {
        if (this.stopped) break;
        if (!started) {
          started = true;
          this.start(segment);
        }
        this.conn.sendBinary(chunk);
      }
    } catch (err) {
      this.conn.logger.warn({ event: 'voice_tts_failed', message: err instanceof Error ? err.message : String(err) });
      this.conn.dropTts();
      if (!this.ttsErrorSent && !this.stopped) {
        this.ttsErrorSent = true;
        this.conn.send({ type: 'error', code: 'tts_failed', message: 'I could not speak that reply.' });
      }
    }
    if (started && !this.stopped) this.end(segment);
  }
}

interface CurrentTurn {
  turnId: string;
  abort: AbortController;
  speaker: Speaker;
  interrupted?: string;
}

export class VoiceConnection {
  private session?: ConversationSession;
  private household?: Household;
  private member?: Member;
  private stt?: SttStream;
  private ready = false;
  private closed = false;
  private early: Buffer[] = [];
  private earlyBytes = 0;
  private helloSeen = false;
  private helloTimer?: NodeJS.Timeout;
  private ttsByLang = new Map<VoiceLang, TtsStream>();
  private chain: Promise<void> = Promise.resolve();
  private current?: CurrentTurn;
  private turnSeq = 0;
  private lastAppState?: string;
  private readonly clock: () => number;
  readonly sarvamLog: VoiceLog;

  constructor(
    private readonly socket: WebSocket,
    private readonly who: AuthedMember,
    private readonly rt: VoiceRuntime,
    readonly logger: VoiceLogger,
  ) {
    this.clock = rt.clock ?? Date.now;
    this.sarvamLog = (level, event, data) => logger[level]({ event, ...data }, event);
    socket.on('close', () => this.cleanup());
    this.helloTimer = setTimeout(() => {
      if (!this.helloSeen) {
        this.send({ type: 'error', code: 'no_hello', message: 'Expected hello.' });
        this.close(1008, 'no hello');
      }
    }, rt.helloTimeoutMs ?? 10_000);
  }

  get sessionId(): string | undefined {
    return this.session?.id;
  }

  // ---------- transport ----------

  send(msg: Record<string, unknown>): void {
    if (this.closed || this.socket.readyState !== OPEN) return;
    this.socket.send(JSON.stringify(msg));
  }

  sendBinary(buf: Buffer): void {
    if (this.closed || this.socket.readyState !== OPEN) return;
    this.socket.send(buf, { binary: true });
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === OPEN) this.socket.close(code, reason);
    this.cleanup();
  }

  handle(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.closed) return;
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (isBinary) {
      this.audio(buf);
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const v = JSON.parse(buf.toString('utf8')) as unknown;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return;
      msg = v as Record<string, unknown>;
    } catch {
      this.logger.debug({ event: 'voice_bad_frame' });
      return;
    }
    switch (msg.type) {
      case 'hello':
        void this.hello(msg).catch((err: unknown) => this.fatal('hello_failed', err));
        return;
      case 'interrupt':
        this.interrupt('interrupt');
        return;
      case 'approve':
        this.enqueue(() => this.approve(msg));
        return;
      case 'cancel':
        this.cancel();
        return;
      case 'bye':
        this.close(1000, 'bye');
        return;
      default:
        return; // unknown types are ignored
    }
  }

  // ---------- state ----------

  setState(s: VoiceState): void {
    const session = this.session;
    if (!session || this.closed) return;
    try {
      session.transition(s);
    } catch (err) {
      this.logger.warn({ event: 'voice_state', message: (err as Error).message });
      return;
    }
    const value = appState(s);
    if (value !== this.lastAppState) {
      this.lastAppState = value;
      this.send({ type: 'state', value });
    }
  }

  // ---------- hello / STT ----------

  private async hello(msg: Record<string, unknown>): Promise<void> {
    if (this.helloSeen) return;
    this.helloSeen = true;
    clearTimeout(this.helloTimer);
    const now = this.clock();
    const household = await this.rt.api.store.loadHousehold(this.who.householdId);
    const member = household.members.find((m) => m.id === this.who.memberId);
    if (!member) {
      this.close(4401, 'unauthorised');
      return;
    }
    if (this.closed) return;
    this.household = household;
    this.member = member;
    const session = this.rt.sessions.get(household.id, member.id, now);
    session.attach(now);
    this.session = session;
    session.lang = voiceLang(typeof msg.locale === 'string' ? msg.locale : undefined, session.lang);
    const hinted = typeof msg.placeHint === 'string' ? placeByHint(household, msg.placeHint) : undefined;
    if (hinted) {
      session.hintPlaceId = hinted.id;
      if (!session.placeId) session.placeId = hinted.id;
    }

    const stt = new SttStream(
      this.rt.sarvam,
      {
        onTranscript: (t) => this.transcript(t),
        onSpeechStart: () => {
          if (this.session?.state === 'speaking') this.interrupt('barge_in');
        },
        onError: (err) => {
          this.logger.warn({ event: 'voice_stt_error', message: err.message });
          this.send({
            type: 'error',
            code: 'stt_error',
            message: 'Speech recognition had a problem; please say that again.',
          });
        },
      },
      { log: this.sarvamLog, ...(this.rt.wsFactory ? { factory: this.rt.wsFactory } : {}) },
    );
    this.stt = stt;
    try {
      await stt.connect();
    } catch (err) {
      this.logger.error({ event: 'voice_stt_unavailable', message: err instanceof Error ? err.message : String(err) });
      this.send({ type: 'error', code: 'stt_unavailable', message: 'Speech recognition is unavailable right now.' });
      this.close(1011, 'stt unavailable');
      return;
    }
    if (this.closed) return;
    this.ready = true;
    const place = this.placeFor(household, member, session);
    this.send({
      type: 'ready',
      sessionId: session.id,
      member: { name: member.name, role: member.role },
      place: { key: place.id, nickname: place.nickname },
    });
    this.setState('listening');
    for (const b of this.early) stt.sendAudio(b);
    this.early = [];
    this.earlyBytes = 0;
  }

  private placeFor(household: Household, member: Member, session: ConversationSession): Place {
    const byId = session.placeId ? household.places.find((p) => p.id === session.placeId) : undefined;
    if (byId) return byId;
    const r = resolvePlace(
      makeRequest({ householdId: household.id, memberId: member.id, text: '' }),
      household,
      member,
    );
    return household.places.find((p) => p.id === r.placeId)!;
  }

  private audio(buf: Buffer): void {
    if (this.ready && this.stt) {
      this.stt.sendAudio(buf);
      return;
    }
    this.early.push(buf);
    this.earlyBytes += buf.length;
    while (this.earlyBytes > MAX_EARLY_AUDIO && this.early.length > 1) this.earlyBytes -= this.early.shift()!.length;
  }

  private transcript(t: SttTranscript): void {
    const session = this.session;
    if (!session || this.closed) return;
    const lang = voiceLang(t.languageCode, session.lang);
    session.lang = lang;
    this.send({ type: 'heard', text: t.text, lang: t.languageCode ?? lang, final: true });
    this.logger.debug(
      { event: 'voice_heard', text: t.text, lang: t.languageCode, probability: t.languageProbability },
      'voice_heard',
    );
    // A new utterance while a turn is still running supersedes it.
    if (this.current) this.interrupt('superseded');
    this.enqueue(() => this.turn(t.text, lang, t.finalMs));
  }

  private enqueue(job: () => Promise<void>): void {
    this.chain = this.chain
      .then(job)
      .catch((err: unknown) =>
        this.logger.error({ event: 'voice_job_failed', message: (err as Error)?.message ?? String(err) }),
      );
  }

  // ---------- TTS ----------

  tts(lang: VoiceLang): TtsStream {
    let s = this.ttsByLang.get(lang);
    if (!s || s.isClosed) {
      s = new TtsStream(
        {
          apiKey: this.rt.sarvam.apiKey,
          ttsUrl: this.rt.sarvam.ttsUrl,
          model: this.rt.sarvam.ttsModel,
          languageCode: lang,
          speaker: this.rt.sarvam.speakers[lang],
          pace: this.rt.sarvam.pace,
        },
        { log: this.sarvamLog, ...(this.rt.wsFactory ? { factory: this.rt.wsFactory } : {}) },
      );
      this.ttsByLang.set(lang, s);
    }
    return s;
  }

  /** Close every TTS socket (barge-in, errors). The next segment reconnects. */
  dropTts(): void {
    for (const s of this.ttsByLang.values()) s.close();
    this.ttsByLang.clear();
  }

  private fillerKey(lang: VoiceLang): string {
    return FillerCache.key(this.rt.sarvam.ttsModel, this.rt.sarvam.speakers[lang], lang);
  }

  private warmFillers(lang: VoiceLang): void {
    const key = this.fillerKey(lang);
    if (this.rt.fillers.has(key)) return;
    const stream = new TtsStream(
      {
        apiKey: this.rt.sarvam.apiKey,
        ttsUrl: this.rt.sarvam.ttsUrl,
        model: this.rt.sarvam.ttsModel,
        languageCode: lang,
        speaker: this.rt.sarvam.speakers[lang],
        pace: this.rt.sarvam.pace,
      },
      { log: this.sarvamLog, ...(this.rt.wsFactory ? { factory: this.rt.wsFactory } : {}) },
    );
    void this.rt.fillers.warm(key, lang, (text) => synthesizeAll(stream, text)).finally(() => stream.close());
  }

  // ---------- turns ----------

  private interrupt(reason: string): void {
    const cur = this.current;
    if (!cur) return;
    if (!cur.interrupted) cur.interrupted = reason;
    cur.abort.abort();
    cur.speaker.stop();
    this.setState('listening');
  }

  private conversationDeps(): ConversationDeps {
    return {
      ...this.rt.api,
      approve: (hash, who) => this.rt.approve(hash, who),
      voiceApprovalMaxPaise: this.rt.config.approvalMaxPaise,
      confirmWindowMs: this.rt.config.confirmWindowMs,
      clock: this.clock,
      maxTurns: this.rt.config.maxTurns,
      log: (event, data) => this.logger.warn({ event, detail: typeof data === 'string' ? scrub(data) : data }, event),
    };
  }

  private async turn(text: string, lang: VoiceLang, sttFinalMs: number | undefined): Promise<void> {
    const session = this.session;
    if (!session || this.closed) return;
    session.refresh(this.clock());
    const turnId = `t${++this.turnSeq}`;
    const t0 = performance.now();
    const abort = new AbortController();
    const speaker = new Speaker(this, turnId, lang);
    const cur: CurrentTurn = { turnId, abort, speaker };
    this.current = cur;
    this.setState('thinking');
    this.warmFillers(lang);

    const splitter = new SentenceSplitter();
    let inflight = 0;
    let fillerTimer: NodeJS.Timeout | undefined;
    let fillerPlayed = false;
    const hooks: TurnHooks = {
      signal: abort.signal,
      onText: (delta) => {
        if (abort.signal.aborted) return;
        for (const s of splitter.push(delta)) speaker.say(s);
      },
      onToolStart: () => {
        inflight++;
        if (fillerTimer || fillerPlayed) return;
        fillerTimer = setTimeout(() => {
          fillerTimer = undefined;
          if (abort.signal.aborted || inflight === 0) return;
          const f = this.rt.fillers.pick(this.fillerKey(lang));
          if (f) fillerPlayed = speaker.filler(f);
        }, this.rt.config.fillerAfterMs);
      },
      onToolEnd: () => {
        inflight = Math.max(0, inflight - 1);
        if (inflight === 0 && fillerTimer) {
          clearTimeout(fillerTimer);
          fillerTimer = undefined;
        }
      },
      onCart: (c) => this.send({ type: 'cart', quote: c.quote, removed: c.removed }),
      onDecision: (d) => {
        if (d.needsBiometric) session.biometric = { quoteHash: d.quoteHash, at: this.clock() };
        this.send({ type: 'decision', ...d });
      },
      onOrder: (o) => this.send({ type: 'order', ...o }),
    };

    let res: TurnResult | undefined;
    try {
      res = await runConversationTurn(session, text, lang, this.conversationDeps(), hooks);
    } catch (err) {
      this.logger.error({
        event: 'voice_turn_failed',
        message: scrub(err instanceof Error ? err.message : String(err)),
      });
      if (!abort.signal.aborted) speaker.say(phrase('failed', lang));
    }
    clearTimeout(fillerTimer);
    if (!abort.signal.aborted) {
      for (const s of splitter.end()) speaker.say(s);
      if (res?.byCode) for (const s of splitSentences(res.text)) speaker.say(s);
    }
    speaker.busy = false;
    await speaker.finished();
    if (this.current === cur) this.current = undefined;
    // A question that was cut off (barge-in, superseded, disconnect) was not fully asked: no yes can answer it.
    if (cur.interrupted) session.pending = undefined;
    if (!this.closed) this.setState(session.pending ? 'awaiting_confirmation' : 'listening');

    const telemetry: VoiceTurnTelemetry = {
      event: 'voice_turn',
      sessionId: session.id,
      turnId,
      lang,
      model: res?.model ?? '',
      ...(sttFinalMs !== undefined ? { sttFinalMs } : {}),
      ...(res?.llmFirstTokenMs !== undefined ? { llmFirstTokenMs: res.llmFirstTokenMs } : {}),
      ...(speaker.firstAudioAt !== undefined ? { ttsFirstAudioMs: Math.round(speaker.firstAudioAt - t0) } : {}),
      totalMs: Math.round(performance.now() - t0),
      toolCalls: res?.toolCalls ?? [],
      outcome: res?.outcome ?? 'failed',
      ...(fillerPlayed ? { filler: true } : {}),
      ...(cur.interrupted ? { interrupted: cur.interrupted } : {}),
      ...(res?.usage ? { usage: res.usage } : {}),
    };
    this.logger.info(telemetry, 'voice_turn');
  }

  // ---------- app-driven approvals ----------

  private async approve(msg: Record<string, unknown>): Promise<void> {
    const session = this.session;
    const member = this.member;
    if (!session || !member || this.closed) return;
    const quoteHash = typeof msg.quoteHash === 'string' ? msg.quoteHash : '';
    const refuse = (why: string) => {
      this.logger.info({ event: 'voice_approve_refused', reason: why });
      this.send({ type: 'error', code: 'approve_refused', message: why });
    };
    if (msg.biometric !== true) return refuse('Face ID is required.');
    if (member.role !== 'owner') return refuse('Only an owner can approve payment.');
    if (!session.authenticated) return refuse('This connection cannot approve payment.');
    const asked = session.biometric;
    if (!asked || asked.quoteHash !== quoteHash) return refuse('That cart is not waiting for approval.');
    if (this.clock() - asked.at >= BIOMETRIC_WINDOW_MS) {
      session.biometric = undefined;
      return refuse('The approval window has passed; ask again.');
    }
    session.biometric = undefined;
    session.pending = undefined;
    const lang = session.lang;
    this.setState('thinking');
    let out: ApprovalOutcome;
    try {
      out = await this.rt.approve(quoteHash, this.who);
    } catch (err) {
      this.logger.warn({
        event: 'voice_approve_failed',
        message: scrub(err instanceof Error ? err.message : String(err)),
      });
      this.send({ type: 'error', code: 'approve_failed', message: 'Approval failed; nothing was ordered.' });
      return;
    }
    this.send({
      type: 'decision',
      verdict: out.decision.verdict,
      reasons: out.decision.reasons,
      quoteHash,
      needsBiometric: false,
      spokenConfirmation: false,
    });
    const placed = out.order !== undefined && (out.placed || out.alreadyPlaced === true);
    if (placed) {
      const eta = session.agent?.state.quotes
        ? [...session.agent.state.quotes.values()].find((q) => q.hash === quoteHash)?.etaMinutes
        : undefined;
      this.send({
        type: 'order',
        supplierOrderId: out.order!.supplierOrderId,
        status: out.order!.status,
        ...(eta !== undefined ? { etaMinutes: eta } : {}),
      });
    }
    const reply = placed ? phrase('placed', lang) : phrase('failed', lang);
    noteTurn(
      session,
      `[The owner ${placed ? 'approved the held cart with Face ID; it was placed' : 'approved with Face ID but the gate did not place it'}]`,
      reply,
    );
    const turnId = `t${++this.turnSeq}`;
    const speaker = new Speaker(this, turnId, lang);
    for (const s of splitSentences(reply)) speaker.say(s);
    speaker.busy = false;
    await speaker.finished();
    this.setState('listening');
  }

  private cancel(): void {
    const session = this.session;
    if (!session) return;
    const had = session.pending !== undefined || session.biometric !== undefined;
    session.pending = undefined;
    session.biometric = undefined;
    if (had) noteTurn(session, '[The user cancelled the pending cart]', phrase('cancelled', session.lang));
    if (session.state === 'awaiting_confirmation') this.setState('listening');
  }

  // ---------- teardown ----------

  private fatal(event: string, err: unknown): void {
    this.logger.error({ event, message: scrub(err instanceof Error ? err.message : String(err)) });
    this.send({ type: 'error', code: 'internal', message: 'Something went wrong.' });
    this.close(1011, 'internal error');
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    // The model call stops; a running tool call finishes silently and is recorded in the history.
    if (this.current) {
      this.current.interrupted ??= 'disconnect';
      this.current.abort.abort();
      this.current.speaker.stop();
    }
    this.stt?.close();
    this.dropTts();
    this.session?.detach(this.clock());
  }
}

/** The place the app picked: id, nickname or alias. */
export function placeByHint(household: Household, hint: string): Place | undefined {
  const h = normalisePhrase(hint);
  if (h === '') return undefined;
  return household.places.find(
    (p) => p.id === hint || normalisePhrase(p.nickname) === h || p.aliases.some((a) => normalisePhrase(a) === h),
  );
}
