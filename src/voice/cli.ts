/**
 * Try Sarvam (and the whole voice loop) with your own voice before the iPhone app exists.
 *
 *   pnpm voice:test <file.wav|.m4a> [--mode codemix|transcribe|translit|verbatim|translate] [--lang unknown|bn-IN|hi-IN|en-IN] [--fast]
 *       → converts to 16 kHz mono PCM (ffmpeg), streams it to Sarvam STT in real time, prints every transcript with
 *         language_code / probability and latency.
 *   pnpm voice:say "<text>" [--lang bn-IN] [--speaker shubh] [--model bulbul:v3|bulbul:v4-flash|bulbul:v2] [-o out.mp3]
 *       → Bulbul TTS to an MP3 file; prints first-byte latency.
 *   pnpm voice:chat <file.wav|.m4a> [--lang bn-IN] [--place home] [-o reply.mp3] [--stub | --live] [--db --token mtk_...]
 *       → the full loop in-process: /voice gateway on 127.0.0.1, real Sarvam, real agent (ANTHROPIC_API_KEY), stub or
 *         configured supplier (BAZAAR_SUPPLIERS). Writes Bazaar's spoken reply to reply.mp3 and prints the captions.
 *         Default store is in-memory (founding household, a fresh owner token). A real store needs --live, because the
 *         gate may place an order that is within the unattended limits.
 *
 * Reads .env (SARVAM_API_KEY, SARVAM_*, ANTHROPIC_API_KEY, BAZAAR_SUPPLIERS). Never prints keys or tokens.
 */
import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { formatINR } from '../core/money.js';
import {
  STT_MODES,
  TTS_MODELS,
  sarvamConfigFromEnv,
  voiceConfigFromEnv,
  voiceLang,
  type SarvamConfig,
  type SttMode,
  type TtsModel,
} from './config.js';
import { SttStream, TtsStream, type VoiceLog } from './sarvam.js';

const STT_RATE = 16_000;
const FRAME_BYTES = 640; // 20 ms of s16le mono at 16 kHz

// ---------- args ----------

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue;
    if (a === '-o') {
      flags.set('out', argv[++i] ?? '');
      continue;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (v !== undefined) flags.set(k, v);
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')) flags.set(k, argv[++i]!);
      else flags.set(k, true);
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

const flag = (a: Args, k: string): string | undefined => {
  const v = a.flags.get(k);
  return typeof v === 'string' ? v : undefined;
};

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function needSarvam(): SarvamConfig {
  const cfg = sarvamConfigFromEnv();
  if (!cfg) die('SARVAM_API_KEY is not set. Add it to .env (see .env.example).');
  return cfg;
}

const consoleLog =
  (verbose: boolean): VoiceLog =>
  (level, event, data) => {
    if (level === 'debug' && !verbose) return;
    if (level === 'info' && !verbose) return;
    console.error(`[${level}] ${event} ${data ? JSON.stringify(data) : ''}`);
  };

const ms = (t0: number) => `${Math.round(performance.now() - t0)} ms`;
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

// ---------- audio ----------

export function hasFfmpeg(): boolean {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

/** A canonical 16 kHz mono s16le WAV's PCM, without ffmpeg; undefined for anything else. */
export function pcmFromWav(buf: Buffer): Buffer | undefined {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    return undefined;
  let off = 12;
  let fmtOk = false;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      fmtOk = format === 1 && channels === 1 && rate === STT_RATE && bits === 16;
    } else if (id === 'data') {
      return fmtOk ? buf.subarray(body, Math.min(buf.length, body + size)) : undefined;
    }
    off = body + size + (size % 2);
  }
  return undefined;
}

const INSTALL_HINT =
  'ffmpeg is needed to convert audio to 16 kHz mono PCM.\n  Mac:    brew install ffmpeg\n  Ubuntu: sudo apt install -y ffmpeg';

/** Any audio file → 16 kHz mono s16le PCM. */
export async function toPcm16k(file: string): Promise<Buffer> {
  if (!hasFfmpeg()) {
    if (extname(file).toLowerCase() === '.wav') {
      const pcm = pcmFromWav(await readFile(file));
      if (pcm) return pcm;
      die(`${file} is not 16 kHz mono 16-bit PCM WAV.\n${INSTALL_HINT}`);
    }
    die(INSTALL_HINT);
  }
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-ac',
      '1',
      '-ar',
      String(STT_RATE),
      'pipe:1',
    ]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.stderr.on('data', (c: Buffer) => err.push(c));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed: ${Buffer.concat(err).toString()}`)),
    );
  });
}

/** Send PCM in 20 ms frames, paced in real time (or as fast as possible). */
async function stream(pcm: Buffer, send: (frame: Buffer) => void, realtime: boolean): Promise<void> {
  const t0 = performance.now();
  for (let i = 0, n = 0; i < pcm.length; i += FRAME_BYTES, n++) {
    if (realtime) {
      const due = t0 + n * 20;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
    }
    send(pcm.subarray(i, i + FRAME_BYTES));
  }
}

/** Duration of s16le mono 16 kHz PCM: 32 bytes per ms. */
const audioMs = (pcm: Buffer) => Math.round(pcm.length / 32);

const silence = (seconds: number) => Buffer.alloc(Math.round(seconds * STT_RATE) * 2);

// ---------- voice:test ----------

async function sttTest(a: Args): Promise<void> {
  const file = a.positional[0] ?? die('usage: pnpm voice:test <file.wav|.m4a> [--mode codemix] [--lang unknown]');
  const cfg = needSarvam();
  const mode = (flag(a, 'mode') ?? cfg.sttMode) as SttMode;
  if (!(STT_MODES as readonly string[]).includes(mode)) die(`--mode must be one of ${STT_MODES.join(', ')}`);
  const language = flag(a, 'lang') ?? cfg.sttLanguage;
  const pcm = await toPcm16k(file);
  console.log(`audio: ${audioMs(pcm)} ms · mode ${mode} · language-code ${language} · ${cfg.sttModel}`);

  const t0 = performance.now();
  let last = performance.now();
  const finals: number[] = [];
  const stt = new SttStream(
    cfg,
    {
      onSpeechStart: () => console.log(`[${ms(t0)}] START_SPEECH`),
      onSpeechEnd: () => console.log(`[${ms(t0)}] END_SPEECH`),
      onTranscript: (t) => {
        last = performance.now();
        if (t.finalMs !== undefined) finals.push(t.finalMs);
        const prob = t.languageProbability !== undefined ? ` p=${t.languageProbability.toPrecision(2)}` : '';
        const lat = [
          t.finalMs !== undefined ? `end-of-speech→text ${t.finalMs} ms` : undefined,
          t.processingLatencyS !== undefined ? `sarvam ${Math.round(t.processingLatencyS * 1000)} ms` : undefined,
        ]
          .filter(Boolean)
          .join(', ');
        console.log(`[${ms(t0)}] (${t.languageCode ?? '?'}${prob}) ${t.text}${lat ? `   [${lat}]` : ''}`);
      },
      onError: (e) => console.error(`STT error: ${e.message}`),
    },
    { mode, language, log: consoleLog(a.flags.has('verbose')) },
  );
  await stt.connect();
  console.log(`connected in ${ms(t0)}`);
  await stream(Buffer.concat([pcm, silence(1.5)]), (f) => stt.sendAudio(f), !a.flags.has('fast'));
  stt.flush();
  last = performance.now();
  while (performance.now() - last < 3000) await sleep(100);
  stt.close();
  if (finals.length > 0) {
    console.log(
      `transcripts: ${finals.length}; mean end-of-speech→text ${Math.round(finals.reduce((x, y) => x + y, 0) / finals.length)} ms`,
    );
  } else console.log('no final transcript with an END_SPEECH before it (check the audio, or try --mode transcribe)');
}

// ---------- voice:say ----------

async function ttsSay(a: Args): Promise<void> {
  const text =
    a.positional.join(' ').trim() ||
    die('usage: pnpm voice:say "<text>" --lang bn-IN [--speaker x] [--model bulbul:v3] -o out.mp3');
  const cfg = needSarvam();
  const lang = voiceLang(flag(a, 'lang') ?? 'bn-IN', 'bn-IN');
  const languageCode = flag(a, 'lang') ?? lang;
  const model = (flag(a, 'model') ?? cfg.ttsModel) as TtsModel;
  if (!(TTS_MODELS as readonly string[]).includes(model)) die(`--model must be one of ${TTS_MODELS.join(', ')}`);
  const speaker = flag(a, 'speaker') ?? cfg.speakers[lang];
  const out = flag(a, 'out') ?? 'out.mp3';
  const tts = new TtsStream(
    { apiKey: cfg.apiKey, ttsUrl: cfg.ttsUrl, model, languageCode, speaker, pace: cfg.pace },
    { log: consoleLog(a.flags.has('verbose')) },
  );
  const t0 = performance.now();
  const parts: Buffer[] = [];
  try {
    for await (const chunk of tts.synthesize(text)) {
      if (parts.length === 0) console.log(`first audio byte after ${ms(t0)} (includes connecting)`);
      parts.push(chunk);
    }
  } finally {
    tts.close();
  }
  const mp3 = Buffer.concat(parts);
  await writeFile(out, mp3);
  console.log(`${model} · ${languageCode} · speaker ${speaker} · ${mp3.length} bytes in ${ms(t0)} → ${out}`);
}

// ---------- voice:chat ----------

async function chat(a: Args): Promise<void> {
  const file =
    a.positional[0] ?? die('usage: pnpm voice:chat <file.wav|.m4a> [--lang bn-IN] [--place home] [-o reply.mp3]');
  const voice = voiceConfigFromEnv();
  if (!voice.sarvam) die('SARVAM_API_KEY is not set. Add it to .env (see .env.example).');
  if (!process.env.ANTHROPIC_API_KEY) die('ANTHROPIC_API_KEY is not set (the agent needs it).');
  const out = flag(a, 'out') ?? 'reply.mp3';
  const locale = flag(a, 'lang') ?? 'bn-IN';

  const [{ MemoryStore }, { anthropicClient }, { issueMemberToken }, { buildServer }, { foundingHousehold }, registry] =
    await Promise.all([
      import('../agent/memory-store.js'),
      import('../agent/llm.js'),
      import('../api/auth.js'),
      import('../api/server.js'),
      import('../db/seed-data.js'),
      import('../suppliers/registry.js'),
    ]);

  const ids = a.flags.has('stub')
    ? ['stub']
    : (process.env.BAZAAR_SUPPLIERS ?? 'stub')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  if (ids.some((id) => id !== 'stub') && !a.flags.has('live')) {
    die(
      `BAZAAR_SUPPLIERS=${ids.join(',')} is a real store. voice:chat would build a real cart there, and the gate WILL place an order that is within the unattended limits.\nRe-run with --live to allow that, or with --stub for the in-memory store.`,
    );
  }
  const suppliers = ids.map((id) => registry.getSupplier(id as Parameters<typeof registry.getSupplier>[0]));

  let store;
  let householdId: string;
  let token: string;
  if (a.flags.has('db')) {
    if (!process.env.DATABASE_URL || !process.env.BAZAAR_HOUSEHOLD_ID)
      die('--db needs DATABASE_URL and BAZAAR_HOUSEHOLD_ID');
    token =
      flag(a, 'token') ??
      process.env.BAZAAR_MEMBER_TOKEN ??
      die(
        '--db needs --token mtk_... (or BAZAAR_MEMBER_TOKEN); issuing one here would revoke the member’s current token',
      );
    const [{ createDb }, { DbStore }] = await Promise.all([import('../db/client.js'), import('../db/store.js')]);
    store = new DbStore(createDb().db);
    householdId = process.env.BAZAAR_HOUSEHOLD_ID;
  } else {
    const household = foundingHousehold();
    const memory = new MemoryStore([household]);
    store = memory;
    householdId = household.id;
    const ownerMember = household.members.find((m) => m.role === 'owner')!;
    token = await issueMemberToken(memory, ownerMember.id);
    console.log(`in-memory household, speaking as ${ownerMember.name} (owner) · suppliers: ${ids.join(', ')}`);
  }

  const logs: Record<string, unknown>[] = [];
  const app = buildServer(
    {
      store,
      suppliers,
      llm: anthropicClient(),
      apiToken: 'voice-chat-local',
      defaultHouseholdId: householdId,
      voice: { config: voice },
    },
    {
      logStream: {
        write: (line: string) => {
          const l = JSON.parse(line) as Record<string, unknown>;
          logs.push(l);
          if (typeof l.event === 'string' && /^sarvam_|_failed$|voice_stt/.test(l.event))
            console.error(`[log] ${line.trim()}`);
        },
      },
    },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const pcm = await toPcm16k(file);
  console.log(`audio: ${audioMs(pcm)} ms`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`, { headers: { authorization: `Bearer ${token}` } });
  const audio: Buffer[] = [];
  const t0 = performance.now();
  let ready = false;
  let heard = false;
  let busy = false;
  let done = false;
  let closed = false;
  ws.on('close', (code, reason) => {
    closed = true;
    if (code !== 1000 && code !== 1005) console.error(`socket closed ${code} ${reason.toString()}`);
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      audio.push(data as Buffer);
      return;
    }
    const m = JSON.parse(data.toString()) as Record<string, unknown>;
    const at = `[${ms(t0)}]`;
    switch (m.type) {
      case 'ready':
        ready = true;
        console.log(
          `${at} ready · ${(m.member as { name: string }).name} @ ${(m.place as { nickname: string }).nickname}`,
        );
        break;
      case 'state':
        if (m.value !== 'listening') busy = true;
        else if (heard && busy) done = true;
        break;
      case 'heard':
        heard = true;
        console.log(`${at} you (${String(m.lang)}): ${String(m.text)}`);
        break;
      case 'say':
        console.log(`${at} bazaar: ${String(m.text)}`);
        break;
      case 'cart': {
        const q = m.quote as { total: number; lines: { name: string; qty: number }[]; place: string };
        console.log(
          `${at} cart @ ${q.place}: ${q.lines.map((l) => `${l.qty} x ${l.name}`).join(', ')} · total ${formatINR(q.total)}`,
        );
        break;
      }
      case 'decision':
        console.log(
          `${at} gate: ${String(m.verdict)}${m.needsPin ? ' (needs PIN)' : ''}${m.spokenConfirmation ? ' (say yes to confirm)' : ''}`,
        );
        break;
      case 'order':
        console.log(`${at} ORDER PLACED: ${String(m.supplierOrderId)} (${String(m.status)})`);
        break;
      case 'error':
        console.error(`${at} error ${String(m.code)}: ${String(m.message)}`);
        break;
      default:
        break;
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({
      type: 'hello',
      appVersion: 'cli',
      device: 'voice:chat',
      locale,
      ...(flag(a, 'place') ? { placeHint: flag(a, 'place') } : {}),
    }),
  );
  while (!ready && !closed) await sleep(10);
  if (!ready) die('the gateway closed the voice session before it was ready (see the log lines above)');

  // Speak, then keep the mic "open" with silence (as the app does) until the turn completes.
  const send = (f: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(f, { binary: true });
  };
  await stream(pcm, send, true);
  const deadline = performance.now() + 90_000;
  while (!done && !closed && performance.now() < deadline) await stream(silence(0.2), send, true);
  if (!done) console.error('timed out waiting for the reply');

  await writeFile(out, Buffer.concat(audio));
  const turn = logs.find((l) => l.event === 'voice_turn');
  if (turn) {
    const pick = (k: string) => (turn[k] === undefined ? '-' : `${String(turn[k])} ms`);
    console.log(
      `timings: stt_final ${pick('sttFinalMs')} · llm_first_token ${pick('llmFirstTokenMs')} · tts_first_audio ${pick('ttsFirstAudioMs')} · total ${pick('totalMs')} · outcome ${String(turn.outcome)}`,
    );
  }
  console.log(`reply audio: ${Buffer.concat(audio).length} bytes → ${out}`);
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'bye' }));
  await sleep(100);
  ws.close();
  await app.close();
  process.exit(0);
}

// ---------- main ----------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const run = command === 'test' ? sttTest : command === 'say' ? ttsSay : command === 'chat' ? chat : undefined;
  if (!run) die('usage: tsx src/voice/cli.ts test|say|chat ...');
  run(args).catch((err: unknown) => die(err instanceof Error ? err.message : String(err)));
}
