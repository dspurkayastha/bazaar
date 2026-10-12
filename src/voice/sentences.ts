/**
 * Splits streamed model text into speakable sentences, so each one goes to TTS the moment it is complete and the
 * first audio starts before the whole reply exists.
 *
 * Boundaries: `।` `?` `!` newline always; `.` only when followed by whitespace (so "₹58.50" and "1.5 kg" stay whole).
 * Very long runs without punctuation are cut at the last comma or space after SOFT_MAX characters.
 */
const ALWAYS = new Set(['।', '?', '!', '\n', '॥']);
const SOFT_MAX = 220;
/** Fragments shorter than this ("Ok." / "১।") are merged into the next sentence. */
const MIN_CHARS = 4;

/** Strip what TTS should not read: markdown markers, gate lines, bare URLs. */
export function speakable(text: string): string {
  return text
    .replace(/\bGate:.*$/s, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>|~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class SentenceSplitter {
  private buf = '';
  private carry = '';

  /** Feed a text delta; returns the sentences it completed (already cleaned, never empty). */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i]!;
      let cut = -1;
      if (ALWAYS.has(ch)) cut = i + 1;
      else if (ch === '.' || ch === '…') {
        const next = this.buf[i + 1];
        if (next === undefined) break; // wait for the next character to decide
        if (/\s/.test(next)) cut = i + 1;
      }
      if (cut > 0) {
        this.emit(this.buf.slice(start, cut), out);
        start = cut;
      }
    }
    this.buf = this.buf.slice(start);
    if (this.buf.length > SOFT_MAX) {
      const head = this.buf.slice(0, SOFT_MAX);
      const at = Math.max(head.lastIndexOf(','), head.lastIndexOf('،'), head.lastIndexOf(' '));
      const cut = at > SOFT_MAX / 2 ? at + 1 : SOFT_MAX;
      this.emit(this.buf.slice(0, cut), out);
      this.buf = this.buf.slice(cut);
    }
    return out;
  }

  /** The rest, at the end of the reply. */
  end(): string[] {
    const out: string[] = [];
    const rest = speakable(this.carry + this.buf);
    this.buf = '';
    this.carry = '';
    if (rest !== '') out.push(rest);
    return out;
  }

  private emit(piece: string, out: string[]): void {
    const s = speakable(this.carry + piece);
    if (s === '') {
      this.carry = '';
      return;
    }
    if (s.length < MIN_CHARS) {
      this.carry = `${s} `;
      return;
    }
    this.carry = '';
    out.push(s);
  }
}

/** Whole text → sentences (for code-generated replies). */
export function splitSentences(text: string): string[] {
  const s = new SentenceSplitter();
  return [...s.push(text), ...s.end()];
}
