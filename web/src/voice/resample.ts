export const TARGET_RATE = 16_000;
export const FRAME_MS = 40;
export const FRAME_SAMPLES = (TARGET_RATE * FRAME_MS) / 1000; // 640

/**
 * Streaming downsampler: box-filter average over each output sample's input span
 * (fractional edges weighted), which doubles as a cheap anti-alias for speech.
 * Feed it chunks of any size; it keeps the leftover between calls.
 */
export class Resampler {
  private readonly ratio: number;
  private buf = new Float32Array(0);
  private pos = 0;

  constructor(inRate: number, outRate: number = TARGET_RATE) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error('rates must be positive');
    this.ratio = inRate / outRate;
  }

  push(input: Float32Array): Float32Array {
    if (input.length) {
      const next = new Float32Array(this.buf.length + input.length);
      next.set(this.buf);
      next.set(input, this.buf.length);
      this.buf = next;
    }
    const out: number[] = [];
    const r = this.ratio;
    while (this.pos + r <= this.buf.length + 1e-9) {
      const start = this.pos;
      const end = Math.min(this.pos + r, this.buf.length);
      let sum = 0;
      for (let k = Math.floor(start); k < Math.ceil(end); k++) {
        const w = Math.min(k + 1, end) - Math.max(k, start);
        sum += w * (this.buf[k] ?? 0);
      }
      out.push(sum / (end - start));
      this.pos += r;
    }
    const drop = Math.min(Math.floor(this.pos), this.buf.length);
    if (drop > 0) {
      this.buf = this.buf.slice(drop);
      this.pos -= drop;
    }
    return Float32Array.from(out);
  }
}

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Collects Int16 samples and emits fixed-size frames (default 640 samples = 40 ms at 16 kHz). */
export class Framer {
  private pending = new Int16Array(0);
  constructor(private readonly size: number = FRAME_SAMPLES) {}

  push(samples: Int16Array): Int16Array[] {
    const all = new Int16Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    const frames: Int16Array[] = [];
    let i = 0;
    for (; i + this.size <= all.length; i += this.size) frames.push(all.slice(i, i + this.size));
    this.pending = all.slice(i);
    return frames;
  }
}

/** Little-endian bytes for the wire (iOS and x86/ARM are LE, but be explicit). */
export function int16ToLEBytes(frame: Int16Array): ArrayBuffer {
  const buf = new ArrayBuffer(frame.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < frame.length; i++) view.setInt16(i * 2, frame[i] ?? 0, true);
  return buf;
}
