/**
 * Voice configuration from the environment (docs/VOICE_PROTOCOL.md). Nothing here talks to the network.
 *
 *   SARVAM_API_KEY            required for /voice; unset → the route sends `error` voice_unconfigured and closes
 *   SARVAM_STT_MODE           transcribe | translate | verbatim | translit | codemix (default codemix)
 *   SARVAM_STT_LANGUAGE       bn-IN, hi-IN, en-IN, … or `unknown` for auto-detect (default unknown)
 *   SARVAM_TTS_MODEL          bulbul:v2 | bulbul:v3 | bulbul:v4-flash (default bulbul:v3)
 *   SARVAM_SPEAKER_BN/HI/EN   TTS voice per language (default shubh)
 *   VOICE_APPROVAL_MAX_RUPEES spoken "yes" approves a held cart only up to this total, whole rupees (default 2000)
 */
import { rupees } from '../core/money.js';
import type { Paise } from '../core/types.js';

export const VOICE_LANGS = ['bn-IN', 'hi-IN', 'en-IN'] as const;
export type VoiceLang = (typeof VOICE_LANGS)[number];

export const STT_MODES = ['transcribe', 'translate', 'verbatim', 'translit', 'codemix'] as const;
export type SttMode = (typeof STT_MODES)[number];

export const TTS_MODELS = ['bulbul:v2', 'bulbul:v3', 'bulbul:v4-flash'] as const;
export type TtsModel = (typeof TTS_MODELS)[number];

export const SARVAM_STT_URL = 'wss://api.sarvam.ai/speech-to-text/ws';
export const SARVAM_TTS_URL = 'wss://api.sarvam.ai/text-to-speech/ws';
/** Documented example speaker; replace per language once the user has picked voices. */
export const DEFAULT_SPEAKER = 'shubh';
/** MP3 sample rate we ask Bulbul for and announce in `audio_start`. */
export const TTS_SAMPLE_RATE = 24_000;
export const STT_SAMPLE_RATE = 16_000;

export interface SarvamConfig {
  apiKey: string;
  sttUrl: string;
  ttsUrl: string;
  sttModel: string;
  sttMode: SttMode;
  /** BCP-47 code or `unknown` (auto-detect; Sarvam then reports language_probability). */
  sttLanguage: string;
  highVadSensitivity: boolean;
  ttsModel: TtsModel;
  speakers: Record<VoiceLang, string>;
  pace: number;
}

export interface VoiceConfig {
  /** Undefined when SARVAM_API_KEY is missing: /voice answers voice_unconfigured. */
  sarvam?: SarvamConfig;
  /** Spoken approvals only up to this total (exact paise). */
  approvalMaxPaise: Paise;
  /** A spoken "yes" counts only this long after the question (90 s). */
  confirmWindowMs: number;
  /** Play a cached filler when a tool call has been running this long (1.2 s). */
  fillerAfterMs: number;
  /** Conversation history is dropped after this much idle time (10 min). */
  sessionTtlMs: number;
  /** History cap, in turns (20). */
  maxTurns: number;
}

export const DEFAULT_VOICE_APPROVAL_MAX_RUPEES = 2000;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  const v = value?.trim();
  if (!v) return fallback;
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${name} must be one of ${allowed.join(', ')}`);
  return v as T;
}

export function parseApprovalMax(raw: string | undefined): Paise {
  const v = raw?.trim();
  if (!v) return rupees(DEFAULT_VOICE_APPROVAL_MAX_RUPEES);
  if (!/^\d+$/.test(v)) throw new Error('VOICE_APPROVAL_MAX_RUPEES must be a whole number of rupees');
  return rupees(Number(v));
}

/** Build the Sarvam part from env; undefined without an API key. */
export function sarvamConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SarvamConfig | undefined {
  const apiKey = env.SARVAM_API_KEY?.trim();
  if (!apiKey) return undefined;
  const speaker = (k: string) => env[k]?.trim() || DEFAULT_SPEAKER;
  return {
    apiKey,
    sttUrl: env.SARVAM_STT_URL?.trim() || SARVAM_STT_URL,
    ttsUrl: env.SARVAM_TTS_URL?.trim() || SARVAM_TTS_URL,
    sttModel: 'saaras:v4',
    sttMode: oneOf(env.SARVAM_STT_MODE, STT_MODES, 'codemix', 'SARVAM_STT_MODE'),
    sttLanguage: env.SARVAM_STT_LANGUAGE?.trim() || 'unknown',
    highVadSensitivity: env.SARVAM_HIGH_VAD_SENSITIVITY === 'true',
    ttsModel: oneOf(env.SARVAM_TTS_MODEL, TTS_MODELS, 'bulbul:v3', 'SARVAM_TTS_MODEL'),
    speakers: {
      'bn-IN': speaker('SARVAM_SPEAKER_BN'),
      'hi-IN': speaker('SARVAM_SPEAKER_HI'),
      'en-IN': speaker('SARVAM_SPEAKER_EN'),
    },
    pace: 1.05,
  };
}

export function voiceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const sarvam = sarvamConfigFromEnv(env);
  return {
    ...(sarvam ? { sarvam } : {}),
    approvalMaxPaise: parseApprovalMax(env.VOICE_APPROVAL_MAX_RUPEES),
    confirmWindowMs: 90_000,
    fillerAfterMs: 1_200,
    sessionTtlMs: 10 * 60_000,
    maxTurns: 20,
  };
}

/** STT language → the TTS language for the reply: one of bn-IN / hi-IN / en-IN, else the fallback. */
export function voiceLang(code: string | undefined | null, fallback: VoiceLang = 'en-IN'): VoiceLang {
  if (!code) return fallback;
  const c = code.trim().toLowerCase();
  for (const l of VOICE_LANGS) if (l.toLowerCase() === c || l.slice(0, 2) === c.slice(0, 2)) return l;
  return fallback;
}
