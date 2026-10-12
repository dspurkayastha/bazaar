/**
 * Voice configuration from the environment (docs/VOICE_PROTOCOL.md). Nothing here talks to the network.
 *
 *   SARVAM_API_KEY            required for /voice; unset → the route sends `error` voice_unconfigured and closes
 *   SARVAM_STT_MODE           transcribe | translate | verbatim | translit | codemix (default codemix)
 *   SARVAM_STT_LANGUAGE       bn-IN, hi-IN, en-IN, … or `unknown` for auto-detect (default unknown)
 *   SARVAM_TTS_MODEL          bulbul:v2 | bulbul:v3 | bulbul:v4-flash (default bulbul:v3)
 *   SARVAM_SPEAKER_BN/HI/EN   TTS voice per language (default shubh)
 *   (PIN_REQUIRED_ABOVE_RUPEES, src/api/web-config.ts, caps what a spoken "yes" can approve; above it the PIN is needed)
 */
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
  /** A spoken "yes" counts only this long after the question (90 s). */
  confirmWindowMs: number;
  /** Play a cached filler when a tool call has been running this long (1.2 s). */
  fillerAfterMs: number;
  /** Conversation history is dropped after this much idle time (10 min). */
  sessionTtlMs: number;
  /** History cap, in turns (20). */
  maxTurns: number;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  const v = value?.trim();
  if (!v) return fallback;
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${name} must be one of ${allowed.join(', ')}`);
  return v as T;
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
