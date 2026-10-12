/** /voice protocol conformance against fake Sarvam servers (docs/VOICE_PROTOCOL.md). No network beyond loopback. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/agent/memory-store.js';
import { issueMemberToken } from '../src/api/auth.js';
import type { Household, Place, Quote, SupplierProduct } from '../src/core/types.js';
import { StubSupplier } from '../src/suppliers/stub/index.js';
import { FILLERS, FillerCache } from '../src/voice/fillers.js';
import { NOW, adder, household, owner } from './fixtures/context.js';
import { asked, say, use, type Step } from './fixtures/llm.js';
import { sleep, until } from './fixtures/sarvam.js';
import { FakeKeypad, StreamingLlm, VoiceClient, startVoice, type VoiceHarness } from './fixtures/voice.js';
import { PIN, setPin } from './fixtures/api.js';
import { SessionService } from '../src/auth/session.js';
import WebSocket from 'ws';

let h: Household;
let store: MemoryStore;
let supplier: StubSupplier;
let harness: VoiceHarness | undefined;
const clients: VoiceClient[] = [];
let ownerToken: string;
let adderToken: string;

beforeEach(async () => {
  h = household();
  store = new MemoryStore([h]);
  supplier = new StubSupplier({ now: () => NOW });
  ownerToken = await issueMemberToken(store, owner(h).id);
  adderToken = await issueMemberToken(store, adder(h).id);
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await harness?.stop();
  harness = undefined;
});

const cart1123 = [asked('v-milk', 2, 'milk'), asked('v-rice', 1), asked('v-chicken', 2), asked('v-onion-1kg', 4)];
const cart412 = [asked('v-milk', 1), asked('v-rice', 1), asked('v-onion-1kg', 2)];
const held: Step[] = [
  [use('search_many', { queries: ['milk', 'rice', 'chicken', 'onion'] })],
  [use('build_cart', { lines: cart1123 })],
  [use('propose_checkout', {})],
  [say('Home-er jonno sob mile egaroshō teish taka. Order kori?')],
];

async function start(
  steps: Step[],
  opts: Partial<Parameters<typeof startVoice>[0]> & { llmOpts?: { chunk?: number; delayMs?: number } } = {},
) {
  const llm = new StreamingLlm(steps, opts.llmOpts);
  harness = await startVoice({
    store,
    suppliers: opts.suppliers ?? [supplier],
    llm,
    householdId: h.id,
    now: () => NOW,
    ...opts,
  });
  return { llm, harness };
}

/** `token: null` connects without an Authorization header. */
async function connect(token: string | null = ownerToken, hello: Record<string, unknown> | false = {}) {
  const c = VoiceClient.connect(harness!.url, token ?? undefined);
  clients.push(c);
  await c.opened;
  if (hello !== false) {
    c.send({ type: 'hello', appVersion: '0.1', device: 'iPhone', locale: 'bn-IN', ...hello });
    await c.waitFor('ready');
  }
  return c;
}

describe('/voice transport and auth', () => {
  it('closes 4401 without a member token, with a bad token, and with the household read token', async () => {
    await start([]);
    for (const token of [null, 'mtk_nope', 'test-token']) {
      const c = await connect(token, false);
      expect(await c.waitClosed()).toBe(4401);
    }
  });

  it('a second connection for the same member closes the first with 4409', async () => {
    await start([]);
    const first = await connect();
    const second = await connect();
    expect(await first.waitClosed()).toBe(4409);
    expect(second.closeCode).toBeUndefined();
    expect(second.messages('ready')).toHaveLength(1);
    // Another member is unaffected.
    const other = await connect(adderToken);
    await sleep(30);
    expect(second.closeCode).toBeUndefined();
    expect(other.messages('ready')).toHaveLength(1);
  });

  it('without SARVAM_API_KEY: error voice_unconfigured, then close', async () => {
    await start([], { unconfigured: true });
    const c = await connect(ownerToken, false);
    await c.waitClosed();
    expect(c.messages('error')[0]).toMatchObject({ code: 'voice_unconfigured' });
    expect(c.closeCode).toBe(1011);
  });

  it('hello → STT connected with the documented query and header → ready, state listening', async () => {
    const { harness } = await start([]);
    const c = await connect(ownerToken, { placeHint: 'hospital' });
    const ready = c.messages('ready')[0]!;
    expect(ready).toMatchObject({ member: { name: owner(h).name, role: 'owner' } });
    expect(typeof ready.sessionId).toBe('string');
    const place = h.places.find((p) => p.nickname === 'hospital' || p.aliases.includes('hospital'))!;
    expect(ready.place).toEqual({ key: place.key, nickname: place.nickname });
    expect(c.trace().slice(0, 2)).toEqual(['ready', 'state:listening']);

    const conn = harness.stt.last;
    expect(conn.headers['api-subscription-key']).toBe('sarvam-test-key');
    const q = Object.fromEntries(conn.url.searchParams);
    expect(q).toMatchObject({
      model: 'saaras:v4',
      mode: 'codemix',
      'language-code': 'unknown',
      sample_rate: '16000',
      input_audio_codec: 'pcm_s16le',
      vad_signals: 'true',
      flush_signal: 'true',
    });
  });

  it('binary PCM frames are forwarded to STT as base64 audio messages', async () => {
    const { harness } = await start([]);
    const c = await connect();
    c.pcm(640);
    c.pcm(1280);
    await until(() => harness.stt.audio().length === 1920);
    const msg = harness.stt.last.received.find((m) => m.audio) as { audio: Record<string, string> };
    expect(msg.audio.sample_rate).toBe('16000');
    expect(msg.audio.encoding).toBe('audio/wav');
  });

  it('ignores unknown message types', async () => {
    await start([]);
    const c = await connect();
    c.send({ type: 'telemetry', x: 1 });
    c.ws.send('not json');
    await sleep(30);
    expect(c.closeCode).toBeUndefined();
    expect(c.messages('error')).toHaveLength(0);
  });
});

describe('/voice turns', () => {
  it('heard → thinking → cart → decision → say → audio_start → binary → audio_end → listening', async () => {
    const { harness } = await start(held);
    const c = await connect();
    harness.stt.utterance('biryani-r jinish ar dudh pathao', 'bn-IN');
    await c.waitFor('audio_end');
    await until(() => c.trace().at(-1) === 'state:listening');

    expect(c.messages('heard')[0]).toEqual({
      type: 'heard',
      text: 'biryani-r jinish ar dudh pathao',
      lang: 'bn-IN',
      final: true,
    });
    const cart = c.messages('cart')[0] as { quote: Quote & Record<string, unknown>; removed: unknown[] };
    expect(cart.quote.total).toBe(112300);
    expect(cart.quote.place).toBe('home');
    expect(cart.quote.lines).toHaveLength(4);
    expect(cart.quote.lines[0]).toEqual(
      expect.objectContaining({ qty: expect.any(Number), lineTotal: expect.any(Number) }),
    );
    expect(c.messages('decision')[0]).toMatchObject({
      verdict: 'HOLD',
      needsPin: false,
      spokenConfirmation: true,
      quoteHash: cart.quote.hash,
    });

    const t = c.trace();
    const order = [
      'heard',
      'state:thinking',
      'cart',
      'decision',
      'say',
      'state:speaking',
      'audio_start',
      'bin',
      'audio_end',
    ];
    let at = -1;
    for (const step of order) {
      const i = t.indexOf(step, at + 1);
      expect(i, `${step} after index ${at} in ${t.join(',')}`).toBeGreaterThan(at);
      at = i;
    }
    // Every binary frame sits between an audio_start and its audio_end, with matching turnId/segment.
    const starts = c.messages('audio_start');
    const ends = c.messages('audio_end');
    expect(starts.length).toBe(ends.length);
    expect(starts[0]).toMatchObject({ codec: 'mp3', sampleRate: 24000, segment: 0 });
    expect(ends[0]).toMatchObject({ turnId: starts[0]!.turnId, segment: 0 });
    let open = false;
    for (const f of c.frames) {
      if (f.kind === 'binary') expect(open).toBe(true);
      else if (f.msg.type === 'audio_start') open = true;
      else if (f.msg.type === 'audio_end') open = false;
    }
    // TTS got the config first, in the turn's language, then the sentences (fillers warm on their own socket).
    const fillerTexts = new Set<string>(FILLERS['bn-IN']);
    const ttsConn = harness.tts.conns.find((x) =>
      x.received.some((m) => m.type === 'text' && !fillerTexts.has((m.data as { text: string }).text)),
    )!;
    expect(ttsConn.url.searchParams.get('model')).toBe('bulbul:v3');
    expect(ttsConn.url.searchParams.get('send_completion_event')).toBe('true');
    expect(ttsConn.received[0]).toMatchObject({
      type: 'config',
      data: {
        model: 'bulbul:v3',
        language_code: 'bn-IN',
        speaker: 'shubh',
        output_audio_codec: 'mp3',
        speech_sample_rate: '24000',
      },
    });
    expect(harness.tts.texts.map((x) => x.text).filter((t) => !fillerTexts.has(t))).toEqual([
      'Home-er jonno sob mile egaroshō teish taka.',
      'Order kori?',
    ]);
  });

  it('streams speech: the first sentence reaches TTS before the model finishes generating', async () => {
    const reply = 'Prothom kotha bolchi. Tarpor aro onek kichu bolar ache, ektu lomba bakko. Sesh.';
    const { harness, llm } = await start([[say(reply)]], { llmOpts: { chunk: 4, delayMs: 15 } });
    const c = await connect();
    harness.stt.utterance('ki khobor', 'bn-IN');
    await until(() => c.messages('audio_end').length === 3);
    const firstTts = harness.tts.texts.find((x) => x.text === 'Prothom kotha bolchi.')!.at;
    expect(firstTts).toBeLessThan(llm.streamEnds[0]!);
    expect(c.messages('say').map((m) => m.text)).toEqual([
      'Prothom kotha bolchi.',
      'Tarpor aro onek kichu bolar ache, ektu lomba bakko.',
      'Sesh.',
    ]);
  });

  it('barge-in: START_SPEECH while speaking → stop_audio, TTS socket closed, model call aborted', async () => {
    const long = 'Ek. '.repeat(1) + 'Ami ekta onek lomba uttor dicchi jeta shesh hote onek somoy lagbe. '.repeat(6);
    const { harness, llm } = await start([[say(long)]], {
      llmOpts: { chunk: 6, delayMs: 20 },
      tts: { chunks: 20, chunkDelayMs: 25 },
    });
    const c = await connect();
    harness.stt.utterance('kichu bolo', 'bn-IN');
    const started = await c.waitFor('audio_start');
    harness.stt.speechStart();
    const stop = await c.waitFor('stop_audio');
    expect(stop.turnId).toBe(started.turnId);
    await until(() => harness.tts.conns.every((x) => x.closed), 3000, 'tts closed');
    await until(() => llm.aborted === 1, 3000, 'llm aborted');
    await until(() => c.trace().at(-1) === 'state:listening');
    // Nothing more for that turn after stop_audio.
    const after = c.frames.slice(c.frames.findIndex((f) => f.kind === 'json' && f.msg.type === 'stop_audio') + 1);
    await sleep(80);
    expect(after.some((f) => f.kind === 'binary' || (f.kind === 'json' && f.msg.type === 'audio_start'))).toBe(false);
    const line = harness.logs.find((l) => l.event === 'voice_turn')!;
    expect(line.interrupted).toBe('barge_in');
    expect(line.outcome).toBe('interrupted');
  });

  it('START_SPEECH while listening does not stop anything', async () => {
    const { harness } = await start([]);
    const c = await connect();
    harness.stt.speechStart();
    await sleep(40);
    expect(c.messages('stop_audio')).toHaveLength(0);
  });

  it('app `interrupt` stops audio the same way', async () => {
    const { harness } = await start([[say('Ekta lomba kotha. '.repeat(10))]], {
      tts: { chunks: 30, chunkDelayMs: 20 },
    });
    const c = await connect();
    harness.stt.utterance('bolo', 'bn-IN');
    await c.waitFor('audio_start');
    c.send({ type: 'interrupt' });
    await c.waitFor('stop_audio');
    await until(() => c.trace().at(-1) === 'state:listening');
  });

  it('a tool call over the filler threshold plays one cached filler in the turn language', async () => {
    class SlowSupplier extends StubSupplier {
      override async search(query: string, place: Place): Promise<SupplierProduct[]> {
        await sleep(150);
        return super.search(query, place);
      }
    }
    const slow = new SlowSupplier({ now: () => NOW });
    const fillers = new FillerCache();
    const { harness } = await start([[use('search', { query: 'milk' })], [say('Dudh peyechi.')]], {
      suppliers: [slow],
      config: { fillerAfterMs: 60 },
    });
    // Seed the cache for this voice (pre-synthesised in production at first use).
    const key = FillerCache.key('bulbul:v3', 'shubh', 'hi-IN');
    harness.fillers.set(key, [{ text: 'एक सेकंड।', audio: Buffer.from('FILLER') }]);
    void fillers;
    const c = await connect();
    harness.stt.utterance('doodh chahiye', 'hi-IN');
    await until(() => c.messages('audio_end').length === 2);
    expect(c.messages('say').map((m) => m.text)).toEqual(['एक सेकंड।', 'Dudh peyechi.']);
    const bins = c.frames.filter((f) => f.kind === 'binary');
    expect((bins[0] as { data: Buffer }).data.toString()).toBe('FILLER');
    expect(harness.logs.find((l) => l.event === 'voice_turn')).toMatchObject({ filler: true, lang: 'hi-IN' });
  });

  it('no filler when the tools are quick', async () => {
    const { harness } = await start([[use('search', { query: 'milk' })], [say('Dudh peyechi.')]]);
    harness.fillers.set(FillerCache.key('bulbul:v3', 'shubh', 'bn-IN'), [
      { text: 'এক সেকেন্ড।', audio: Buffer.from('F') },
    ]);
    const c = await connect();
    harness.stt.utterance('dudh', 'bn-IN');
    await c.waitFor('audio_end');
    await until(() => c.trace().at(-1) === 'state:listening');
    expect(c.messages('say').map((m) => m.text)).toEqual(['Dudh peyechi.']);
  });

  it('fillers are synthesised at first use of a language and cached', async () => {
    const { harness } = await start([[say('Thik ache.')]]);
    const c = await connect();
    harness.stt.utterance('kemon acho', 'bn-IN');
    await c.waitFor('audio_end');
    const key = FillerCache.key('bulbul:v3', 'shubh', 'bn-IN');
    await until(() => harness.fillers.has(key), 3000, 'fillers cached');
    expect(harness.fillers.pick(key)!.audio.toString()).toMatch(/^MP3:/);
  });

  it('writes one voice_turn line with latencies, no transcript at info level', async () => {
    const { harness } = await start(held);
    const c = await connect();
    harness.stt.utterance('biryani-r jinish ar dudh pathao', 'bn-IN');
    await c.waitFor('audio_end');
    await until(() => harness.logs.some((l) => l.event === 'voice_turn'));
    const line = harness.logs.find((l) => l.event === 'voice_turn')!;
    expect(line).toMatchObject({ lang: 'bn-IN', outcome: 'held', model: 'test-model' });
    for (const k of ['sttFinalMs', 'llmFirstTokenMs', 'ttsFirstAudioMs', 'totalMs'])
      expect(typeof line[k]).toBe('number');
    expect((line.toolCalls as { name: string }[]).map((t) => t.name)).toEqual([
      'search_many',
      'build_cart',
      'propose_checkout',
    ]);
    const all = JSON.stringify(harness.logs);
    expect(all).not.toContain('biryani-r jinish');
    expect(all).not.toContain('sarvam-test-key');
    expect(all).not.toContain(ownerToken);
  });

  it('logs the transcript only at debug level', async () => {
    const { harness } = await start([[say('Thik ache.')]], { logLevel: 'debug' });
    const c = await connect();
    harness.stt.utterance('debug-only transcript', 'en-IN');
    await c.waitFor('audio_end');
    const heard = harness.logs.find((l) => l.event === 'voice_heard')!;
    expect(heard.level).toBe(20);
    expect(heard.text).toBe('debug-only transcript');
  });

  it('a rejected TTS speaker is logged verbatim with a fix hint and the app gets a recoverable error', async () => {
    const { harness } = await start([[say('Hello there.')]], {
      tts: { configError: { message: 'Invalid speaker shubh for model bulbul:v3', code: 'invalid_speaker' } },
    });
    const c = await connect();
    harness.stt.utterance('hello', 'en-IN');
    const err = await c.waitFor('error');
    expect(err.code).toBe('tts_failed');
    const rejected = harness.logs.find((l) => l.event === 'sarvam_tts_speaker_rejected')!;
    expect(rejected.hint).toContain('SARVAM_SPEAKER_EN');
    expect(String(rejected.raw)).toContain('Invalid speaker shubh for model bulbul:v3');
    expect(c.messages('say')).toHaveLength(1); // the caption still went out
    expect(c.closeCode).toBeUndefined();
  });

  it('keeps multi-turn history: the second turn sees the first', async () => {
    const { harness, llm } = await start([[say('Ki lagbe?')], [say('Thik ache.')]]);
    const c = await connect();
    harness.stt.utterance('bazar korbo', 'bn-IN');
    await until(() => c.messages('audio_end').length >= 1);
    harness.stt.utterance('dudh', 'bn-IN');
    await until(() => llm.calls === 2);
    const msgs = llm.requests[1]!.messages;
    expect(msgs).toHaveLength(3);
    expect(JSON.stringify(msgs[0])).toContain('bazar korbo');
    expect(msgs[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Ki lagbe?' }] });
    expect(JSON.stringify(msgs[2])).toContain('dudh');
    expect(llm.requests[1]!.tools.map((t) => t.name)).toContain('confirm_pending_order');
    expect(llm.requests[1]!.tools.map((t) => t.name)).not.toContain('ask_user');
  });
});

describe('/voice approvals', () => {
  it('spoken yes from the owner within limits places via the gate', async () => {
    const steps: Step[] = [
      ...held,
      (req) => [use('confirm_pending_order', { quoteHash: hashFrom(req) })],
      [say('Order hoye geche.')],
    ];
    const { harness } = await start(steps);
    const c = await connect();
    harness.stt.utterance('biryani-r jinish pathao', 'bn-IN');
    await until(() => c.trace().at(-1) === 'state:listening' && c.messages('audio_end').length >= 1);
    harness.stt.utterance('hyan, order koro', 'bn-IN');
    const order = await c.waitFor('order');
    expect(order.status).toBe('placed');
    expect(supplier.placed).toHaveLength(1);
    const decisions = c.messages('decision');
    expect(decisions.at(-1)).toMatchObject({ verdict: 'PAY', spokenConfirmation: true });
  });

  it('above the PIN threshold (default ₹500): needsPin, a spoken yes never pays, the keypad PIN places via the gate', async () => {
    await setPin(store, owner(h));
    const keypad = new FakeKeypad();
    const steps: Step[] = [
      ...held,
      (req) => [use('confirm_pending_order', { quoteHash: hashFrom(req) })],
      [say('PIN diye approve korun.')],
    ];
    const { harness, llm } = await start(steps, { pinRequiredAbovePaise: 50_000, keypadFor: () => keypad });
    const c = await connect();
    expect(keypad.attached).toBe(1);
    harness.stt.utterance('biryani-r jinish pathao', 'bn-IN');
    const decision = await c.waitFor('decision');
    expect(decision).toMatchObject({ verdict: 'HOLD', needsPin: true, spokenConfirmation: false });
    expect(decision).not.toHaveProperty('needsBiometric');
    await until(() => c.trace().at(-1) === 'state:listening' && c.messages('audio_end').length >= 1);
    expect(harness.sessions.get(h.id, owner(h).id, Date.now()).state).toBe('awaiting_pin');

    // The owner says yes: refused (needs_pin), the decision is re-sent, nothing placed.
    harness.stt.utterance('hyan, order koro', 'bn-IN');
    await until(() => llm.calls === 6);
    expect(llm.resultsAt(5)[0]!.body).toMatchObject({ ok: false, refused: 'needs_pin', needsPin: true });
    await until(() => c.messages('decision').length === 2);
    expect(supplier.placed).toHaveLength(0);
    await until(() => c.trace().at(-1) === 'state:listening' && c.messages('audio_end').length >= 2);

    // Wrong PIN on the keypad: refused, still waiting; then the right one places.
    keypad.type('0000');
    expect((await c.waitFor('error')).code).toBe('pin_incorrect');
    expect(supplier.placed).toHaveLength(0);
    keypad.type(PIN);
    const order = await c.waitFor('order');
    expect(order).toMatchObject({ status: 'placed' });
    expect(supplier.placed).toHaveLength(1);
    expect(c.messages('decision').at(-1)).toMatchObject({ verdict: 'PAY', needsPin: false });
    await until(() => c.messages('say').some((m) => m.text === 'অর্ডার হয়ে গেছে।'));
    // The digits never reach the logs.
    expect(JSON.stringify(harness.logs)).not.toContain(PIN);
    expect(harness.logs.some((l) => l.event === 'voice_keypad' && l.outcome === 'approved')).toBe(true);
  });

  it('keypad digits are ignored when nothing awaits a PIN, after cancel, and for an adder', async () => {
    await setPin(store, owner(h));
    const keypads = new Map<string, FakeKeypad>();
    const keypadFor = (who: { memberId: string }) => {
      const k = new FakeKeypad();
      keypads.set(who.memberId, k);
      return k;
    };
    const { harness } = await start(held, { pinRequiredAbovePaise: 50_000, keypadFor });
    const c = await connect();
    keypads.get(owner(h).id)!.type(PIN); // nothing pending yet
    harness.stt.utterance('pathao', 'bn-IN');
    await c.waitFor('decision');
    await until(() => c.trace().at(-1) === 'state:listening' && c.messages('audio_end').length >= 1);
    c.send({ type: 'cancel' });
    await sleep(20);
    keypads.get(owner(h).id)!.type(PIN); // cancelled
    // an old-style Face ID approve is an unknown message now: ignored
    c.send({ type: 'approve', quoteHash: 'f'.repeat(64), biometric: true });
    await sleep(50);
    expect(supplier.placed).toHaveLength(0);
    expect(harness.logs.filter((l) => l.event === 'voice_keypad').map((l) => l.reason)).toEqual([
      'nothing_pending',
      'nothing_pending',
    ]);
  });

  it('the web app connects with its session cookie from its own origin only', async () => {
    const web = { origin: 'https://bazaar.test', rpId: 'bazaar.test' };
    await start([], { web });
    const { token } = await new SessionService(store, () => NOW).create(owner(h));
    const open = (headers: Record<string, string>) => {
      const c = new VoiceClient(new WebSocket(harness!.url, { headers }));
      clients.push(c);
      return c;
    };
    const ok = open({ cookie: `bz_session=${token}`, origin: web.origin });
    await ok.opened;
    ok.send({ type: 'hello', appVersion: 'web', device: 'Safari', locale: 'en-IN' });
    expect(await ok.waitFor('ready')).toMatchObject({ member: { name: owner(h).name, role: 'owner' } });
    for (const headers of <Record<string, string>[]>[
      { cookie: `bz_session=${token}`, origin: 'https://evil.example' },
      { cookie: `bz_session=${token}` },
      { cookie: 'bz_session=bzs_nope', origin: web.origin },
    ]) {
      const bad = open(headers);
      await bad.opened;
      expect(await bad.waitClosed()).toBe(4401);
    }
  });

  it('an adder can build a cart by voice but cannot approve it, by voice or keypad', async () => {
    const steps: Step[] = [
      [use('search_many', { queries: ['milk', 'rice', 'onion'] })],
      [use('build_cart', { lines: cart412 })],
      [use('propose_checkout', {})],
      [say('Car-sho baro taka. Owner approve korbe.')],
      (req) => [use('confirm_pending_order', { quoteHash: hashFrom(req) })],
      [say('Owner approve korbe.')],
    ];
    await setPin(store, adder(h)); // even an adder who somehow has a PIN cannot approve
    const keypad = new FakeKeypad();
    const { harness, llm } = await start(steps, { keypadFor: () => keypad });
    const c = await connect(adderToken);
    harness.stt.utterance('dudh chal pyaj', 'bn-IN');
    const decision = await c.waitFor('decision');
    expect(decision).toMatchObject({ verdict: 'HOLD', needsPin: false, spokenConfirmation: false });
    await until(() => c.trace().at(-1) === 'state:listening' && c.messages('audio_end').length >= 1);
    harness.stt.utterance('haan order karo', 'bn-IN');
    await until(() => llm.calls === 6);
    const result = llm.resultsAt(5)[0]!.body;
    expect(result).toMatchObject({ ok: false, refused: 'owner_required' });
    keypad.type(PIN);
    await until(() => harness.logs.some((l) => l.event === 'voice_keypad'));
    expect(harness.logs.find((l) => l.event === 'voice_keypad')).toMatchObject({ reason: 'owner_required' });
    expect(supplier.placed).toHaveLength(0);
  });

  it('`cancel` clears the pending cart: a later yes is refused', async () => {
    const steps: Step[] = [
      ...held,
      (req) => [use('confirm_pending_order', { quoteHash: hashFrom(req) })],
      [say('Thik ache.')],
    ];
    const { harness, llm } = await start(steps);
    const c = await connect();
    harness.stt.utterance('pathao', 'bn-IN');
    await until(() => c.trace().at(-1) === 'state:listening' && c.messages('audio_end').length >= 1);
    c.send({ type: 'cancel' });
    await sleep(20);
    harness.stt.utterance('hyan', 'bn-IN');
    await until(() => llm.calls === 6);
    expect(llm.resultsAt(5)[0]!.body).toMatchObject({ ok: false, refused: 'nothing_pending' });
    expect(supplier.placed).toHaveLength(0);
  });
});

describe('HTTP rate limit', () => {
  it('limits HTTP routes per token (429 past the limit), /health stays open', async () => {
    const { buildServer } = await import('../src/api/server.js');
    const app = buildServer(
      {
        store,
        suppliers: [supplier],
        llm: new StreamingLlm([]),
        apiToken: 'test-token',
        defaultHouseholdId: h.id,
        now: () => NOW,
      },
      { rateLimitMax: 3 },
    );
    const headers = { authorization: `Bearer ${ownerToken}` };
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: 'GET', url: '/places', headers })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    // Another member's token has its own budget.
    expect(
      (await app.inject({ method: 'GET', url: '/places', headers: { authorization: `Bearer ${adderToken}` } }))
        .statusCode,
    ).toBe(200);
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await app.close();
  });
});

/** The quote hash the model was shown in propose_checkout's result (from the conversation history). */
function hashFrom(req: { messages: { role: string; content: unknown }[] }): string {
  const s = JSON.stringify(req.messages);
  const m = /\\"quoteHash\\":\\"([0-9a-f]{64})\\"/.exec(s);
  if (!m) throw new Error('no quoteHash in history');
  return m[1]!;
}
