/**
 * Short cached fillers ("ek second, dekhchi…") played when a tool call runs longer than ~1.2 s. Three per language,
 * synthesised once per (model, speaker, language) at first use and kept in memory as MP3 bytes.
 */
import type { VoiceLang } from './config.js';

export const FILLERS: Record<VoiceLang, readonly string[]> = {
  'bn-IN': ['এক সেকেন্ড, দেখছি।', 'হ্যাঁ, একটু দেখে নিই।', 'একটু দাঁড়ান।'],
  'hi-IN': ['एक सेकंड, देखते हैं।', 'बस एक पल।', 'ठीक है, देख लेते हैं।'],
  'en-IN': ['One second, checking.', 'Just a moment.', 'Okay, looking now.'],
};

export interface Filler {
  text: string;
  audio: Buffer;
}

export type Synth = (text: string) => Promise<Buffer>;

export class FillerCache {
  private readonly ready = new Map<string, Filler[]>();
  private readonly warming = new Map<string, Promise<void>>();
  private readonly rr = new Map<string, number>();

  constructor(private readonly onError: (key: string, err: unknown) => void = () => undefined) {}

  static key(model: string, speaker: string, lang: VoiceLang): string {
    return `${model}|${speaker}|${lang}`;
  }

  /** Start synthesising the fillers for this key (once). Resolves when done; never rejects. */
  warm(key: string, lang: VoiceLang, synth: Synth): Promise<void> {
    if (this.ready.has(key)) return Promise.resolve();
    const existing = this.warming.get(key);
    if (existing) return existing;
    const p = (async () => {
      const got: Filler[] = [];
      for (const text of FILLERS[lang]) {
        try {
          const audio = await synth(text);
          if (audio.length > 0) got.push({ text, audio });
        } catch (err) {
          this.onError(key, err);
        }
      }
      if (got.length > 0) this.ready.set(key, got);
    })().finally(() => this.warming.delete(key));
    this.warming.set(key, p);
    return p;
  }

  /** A ready filler (round robin), or undefined while they are still being made. */
  pick(key: string): Filler | undefined {
    const list = this.ready.get(key);
    if (!list || list.length === 0) return undefined;
    const i = this.rr.get(key) ?? 0;
    this.rr.set(key, i + 1);
    return list[i % list.length];
  }

  has(key: string): boolean {
    return this.ready.has(key);
  }

  /** Seed (tests). */
  set(key: string, fillers: Filler[]): void {
    this.ready.set(key, fillers);
  }
}

/** Process-wide cache: fillers survive reconnects. */
export const sharedFillers = new FillerCache();
