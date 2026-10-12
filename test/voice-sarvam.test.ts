/** Sarvam STT/TTS clients against fake servers, the sentence splitter, and voice env config. No network. */
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { sarvamConfigFromEnv, voiceConfigFromEnv, voiceLang, type SarvamConfig } from '../src/voice/config.js';
import {
  SttStream,
  TtsStream,
  synthesizeAll,
  type SttTranscript,
  type VoiceLog,
  type WebSocketFactory,
} from '../src/voice/sarvam.js';
import { SentenceSplitter, splitSentences } from '../src/voice/sentences.js';
import { FakeStt, FakeTts, sleep, until } from './fixtures/sarvam.js';

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function cfg(stt: FakeStt | undefined, tts: FakeTts | undefined): SarvamConfig {
  return {
    apiKey: 'k-123',
    sttUrl: stt?.url ?? 'ws://127.0.0.1:1/x',
    ttsUrl: tts?.url ?? 'ws://127.0.0.1:1/x',
    sttModel: 'saaras:v4',
    sttMode: 'codemix',
    sttLanguage: 'unknown',
    highVadSensitivity: false,
    ttsModel: 'bulbul:v3',
    speakers: { 'bn-IN': 'shubh', 'hi-IN': 'shubh', 'en-IN': 'shubh' },
    pace: 1.05,
  };
}

function logger() {
  const lines: { level: string; event: string; data?: Record<string, unknown> }[] = [];
  const log: VoiceLog = (level, event, data) => lines.push({ level, event, ...(data ? { data } : {}) });
  return { lines, log };
}

describe('SttStream', () => {
  it('connects through the injected factory with the key header and streams base64 PCM', async () => {
    const stt = await FakeStt.start();
    servers.push(stt);
    const urls: string[] = [];
    const factory: WebSocketFactory = (url, headers) => {
      urls.push(url);
      return new WebSocket(url, { headers });
    };
    const got: SttTranscript[] = [];
    const s = new SttStream(
      cfg(stt, undefined),
      { onTranscript: (t) => got.push(t) },
      { factory, mode: 'translit', language: 'bn-IN' },
    );
    await s.connect();
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get('mode')).toBe('translit');
    expect(new URL(urls[0]!).searchParams.get('language-code')).toBe('bn-IN');
    expect(stt.last.headers['api-subscription-key']).toBe('k-123');

    s.sendAudio(Buffer.from([1, 2, 3, 4]));
    s.flush();
    await until(() => stt.last.received.length === 2);
    expect(stt.last.received[0]).toEqual({ audio: { data: 'AQIDBA==', sample_rate: '16000', encoding: 'audio/wav' } });
    expect(stt.last.received[1]).toEqual({ type: 'flush' });

    stt.speechEnd();
    await sleep(10);
    stt.transcript('ami dudh chai', 'bn-IN', 0.87);
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({
      text: 'ami dudh chai',
      languageCode: 'bn-IN',
      languageProbability: 0.87,
      requestId: 'req_fake',
      audioDurationS: 1.2,
      processingLatencyS: 0.21,
    });
    expect(got[0]!.finalMs).toBeGreaterThanOrEqual(5);
    s.close();
  });

  it('reports START/END_SPEECH and skips empty transcripts', async () => {
    const stt = await FakeStt.start();
    servers.push(stt);
    const events: string[] = [];
    const s = new SttStream(cfg(stt, undefined), {
      onTranscript: (t) => events.push(`t:${t.text}`),
      onSpeechStart: () => events.push('start'),
      onSpeechEnd: () => events.push('end'),
    });
    await s.connect();
    stt.speechStart();
    stt.speechEnd();
    stt.transcript('   ');
    stt.transcript('hi');
    await until(() => events.length === 3);
    expect(events).toEqual(['start', 'end', 't:hi']);
    s.close();
  });

  it('logs an error frame verbatim and surfaces it', async () => {
    const stt = await FakeStt.start();
    servers.push(stt);
    const { lines, log } = logger();
    const errors: string[] = [];
    const s = new SttStream(
      cfg(stt, undefined),
      { onTranscript: () => {}, onError: (e) => errors.push(e.message) },
      { log },
    );
    await s.connect();
    stt.send({ type: 'error', data: { error: 'Unsupported sample_rate', code: 'bad_request', extra_field: 1 } });
    await until(() => errors.length === 1);
    expect(errors[0]).toContain('Unsupported sample_rate');
    const line = lines.find((l) => l.event === 'sarvam_stt_error')!;
    expect(line.data!.raw).toBe(
      '{"type":"error","data":{"error":"Unsupported sample_rate","code":"bad_request","extra_field":1}}',
    );
    expect(JSON.stringify(lines)).not.toContain('k-123');
    s.close();
  });

  it('reconnects on the next audio after an idle close, keeping the audio', async () => {
    const stt = await FakeStt.start();
    servers.push(stt);
    const closes: number[] = [];
    const s = new SttStream(cfg(stt, undefined), { onTranscript: () => {}, onClose: (c) => closes.push(c) });
    await s.connect();
    stt.last.ws.close(1000, 'idle timeout');
    await until(() => closes.length === 1);
    expect(s.open).toBe(false);
    s.sendAudio(Buffer.from([9, 9]));
    await until(() => stt.conns.length === 2 && stt.conns[1]!.received.length === 1);
    expect(stt.audio(stt.conns[1]!)).toEqual(Buffer.from([9, 9]));
    expect(s.metrics.connects).toBe(2);
    s.close();
  });

  it('logs an HTTP refusal of the upgrade verbatim', async () => {
    const { createServer } = await import('node:http');
    const srv = createServer((_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Invalid API key"}}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    servers.push({ close: () => new Promise<void>((r) => srv.close(() => r())) });
    const port = (srv.address() as { port: number }).port;
    const { lines, log } = logger();
    const s = new SttStream(
      { ...cfg(undefined, undefined), sttUrl: `ws://127.0.0.1:${port}/x` },
      { onTranscript: () => {} },
      { log },
    );
    await expect(s.connect()).rejects.toThrow(/HTTP 403/);
    const line = lines.find((l) => l.event === 'sarvam_stt_refused')!;
    expect(line.data).toMatchObject({ status: 403, raw: '{"error":{"message":"Invalid API key"}}' });
  });
});

describe('TtsStream', () => {
  const settings = (tts: FakeTts) => ({
    apiKey: 'k-123',
    ttsUrl: tts.url,
    model: 'bulbul:v4-flash' as const,
    languageCode: 'hi-IN',
    speaker: 'shubh',
  });

  it('sends config first, then text + flush per segment, in order, and yields MP3 until the final event', async () => {
    const tts = await FakeTts.start({ chunks: 3 });
    servers.push(tts);
    const s = new TtsStream(settings(tts));
    const [a, b] = await Promise.all([synthesizeAll(s, 'पहला वाक्य।'), synthesizeAll(s, 'दूसरा।')]);
    expect(a.toString()).toBe('MP3:पहला वाक्य।#0MP3:पहला वाक्य।#1MP3:पहला वाक्य।#2');
    expect(b.toString()).toBe('MP3:दूसरा।#0MP3:दूसरा।#1MP3:दूसरा।#2');
    expect(tts.conns).toHaveLength(1);
    expect(tts.last.url.searchParams.get('model')).toBe('bulbul:v4-flash');
    expect(tts.last.received.map((m) => m.type)).toEqual(['config', 'text', 'flush', 'text', 'flush']);
    expect(tts.last.received[0]).toEqual({
      type: 'config',
      data: {
        model: 'bulbul:v4-flash',
        language_code: 'hi-IN',
        speaker: 'shubh',
        output_audio_codec: 'mp3',
        speech_sample_rate: '24000',
        pace: 1.05,
        min_buffer_size: 50,
        max_chunk_length: 150,
      },
    });
    expect(s.metrics.lastFirstAudioMs).toBeGreaterThanOrEqual(0);
    s.close();
  });

  it('reopens after an idle close', async () => {
    const tts = await FakeTts.start();
    servers.push(tts);
    const s = new TtsStream(settings(tts));
    await synthesizeAll(s, 'one');
    tts.last.ws.close(1000);
    await until(() => tts.last.closed);
    await synthesizeAll(s, 'two');
    expect(tts.conns).toHaveLength(2);
    expect(tts.conns[1]!.received[0]!.type).toBe('config');
    s.close();
  });

  it('throws on an error frame and logs it verbatim; a speaker rejection names the env var', async () => {
    const tts = await FakeTts.start({
      configError: { message: 'Speaker shubh is not available for bulbul:v4-flash', code: 'x' },
    });
    servers.push(tts);
    const { lines, log } = logger();
    const s = new TtsStream(settings(tts), { log });
    await expect(synthesizeAll(s, 'hello')).rejects.toThrow(/Speaker shubh is not available/);
    expect(lines.find((l) => l.event === 'sarvam_tts_error')!.data!.raw).toContain('"code":"x"');
    expect(lines.find((l) => l.event === 'sarvam_tts_speaker_rejected')!.data!.hint).toContain('SARVAM_SPEAKER_HI');
    s.close();
  });

  it('abort mid-segment stops yielding and drops the socket so stale audio cannot leak', async () => {
    const tts = await FakeTts.start({ chunks: 50, chunkDelayMs: 10 });
    servers.push(tts);
    const s = new TtsStream(settings(tts));
    const ac = new AbortController();
    let n = 0;
    for await (const _ of s.synthesize('long text', ac.signal)) {
      if (++n === 2) ac.abort();
    }
    expect(n).toBeLessThan(5);
    await until(() => tts.last.closed);
    // The next segment works on a fresh socket.
    tts.opts.chunks = 1;
    tts.opts.chunkDelayMs = 0;
    expect((await synthesizeAll(s, 'next')).toString()).toBe('MP3:next#0');
    s.close();
  });
});

describe('SentenceSplitter', () => {
  it('splits on danda, ?, !, newline and ". " but not inside numbers', () => {
    const s = new SentenceSplitter();
    const out = [
      ...s.push('মোট ১১২৩ টাকা। Order '),
      ...s.push('kori? Price is ₹58.50 today. Okay!'),
      ...s.push('\nশেষ'),
      ...s.end(),
    ];
    expect(out).toEqual(['মোট ১১২৩ টাকা।', 'Order kori?', 'Price is ₹58.50 today.', 'Okay!', 'শেষ']);
  });

  it('waits for the next character before splitting on "."', () => {
    const s = new SentenceSplitter();
    expect(s.push('It costs 1.')).toEqual([]);
    expect(s.push('5 lakh.')).toEqual([]);
    expect(s.end()).toEqual(['It costs 1.5 lakh.']);
  });

  it('merges tiny fragments into the next sentence and strips markdown and gate lines', () => {
    expect(splitSentences('Ok. **Dudh** nebo?')).toEqual(['Ok. Dudh nebo?']);
    expect(splitSentences('Done. Gate: HOLD (per_order_ceiling) — x')).toEqual(['Done.']);
  });

  it('cuts very long runs at a comma or space', () => {
    const long = `${'word '.repeat(60)}end`;
    const out = new SentenceSplitter().push(long);
    expect(out.length).toBe(1);
    expect(out[0]!.length).toBeLessThanOrEqual(220);
  });
});

describe('voice config', () => {
  it('is unconfigured without SARVAM_API_KEY, with defaults otherwise', () => {
    expect(sarvamConfigFromEnv({})).toBeUndefined();
    const c = voiceConfigFromEnv({ SARVAM_API_KEY: 'k' });
    expect(c.sarvam).toMatchObject({
      sttMode: 'codemix',
      sttLanguage: 'unknown',
      ttsModel: 'bulbul:v3',
      speakers: { 'bn-IN': 'shubh', 'hi-IN': 'shubh', 'en-IN': 'shubh' },
      sttUrl: 'wss://api.sarvam.ai/speech-to-text/ws',
      ttsUrl: 'wss://api.sarvam.ai/text-to-speech/ws',
    });
    expect(c.approvalMaxPaise).toBe(200_000);
    expect(c.confirmWindowMs).toBe(90_000);
  });

  it('reads overrides and rejects bad values', () => {
    const c = voiceConfigFromEnv({
      SARVAM_API_KEY: 'k',
      SARVAM_STT_MODE: 'translit',
      SARVAM_STT_LANGUAGE: 'bn-IN',
      SARVAM_TTS_MODEL: 'bulbul:v4-flash',
      SARVAM_SPEAKER_BN: 'bn-voice',
      VOICE_APPROVAL_MAX_RUPEES: '1500',
    });
    expect(c.sarvam).toMatchObject({ sttMode: 'translit', sttLanguage: 'bn-IN', ttsModel: 'bulbul:v4-flash' });
    expect(c.sarvam!.speakers['bn-IN']).toBe('bn-voice');
    expect(c.approvalMaxPaise).toBe(150_000);
    expect(() => voiceConfigFromEnv({ SARVAM_API_KEY: 'k', SARVAM_STT_MODE: 'nope' })).toThrow(/SARVAM_STT_MODE/);
    expect(() => voiceConfigFromEnv({ SARVAM_TTS_MODEL: 'bulbul:v9', SARVAM_API_KEY: 'k' })).toThrow(
      /SARVAM_TTS_MODEL/,
    );
    expect(() => voiceConfigFromEnv({ VOICE_APPROVAL_MAX_RUPEES: '20.5' })).toThrow(/whole number/);
  });

  it('maps STT languages to the three reply languages', () => {
    expect(voiceLang('bn-IN')).toBe('bn-IN');
    expect(voiceLang('hi')).toBe('hi-IN');
    expect(voiceLang('ta-IN', 'bn-IN')).toBe('bn-IN');
    expect(voiceLang(undefined, 'hi-IN')).toBe('hi-IN');
  });
});
