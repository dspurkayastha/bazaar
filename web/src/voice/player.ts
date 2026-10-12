/**
 * Plays server TTS segments back to back. Each segment is a run of MP3 binary frames between
 * audio_start and audio_end. Decoding starts the moment a segment ends; start times are chained so
 * segments play without gaps. stop() cuts the current sound and drops everything queued or decoding.
 */
export class SegmentPlayer {
  private chunks: ArrayBuffer[] = [];
  private collecting = false;
  private epoch = 0;
  private nextTime = 0;
  private tail: Promise<void> = Promise.resolve();
  private sources = new Set<AudioBufferSourceNode>();
  onIdle: () => void = () => {};

  constructor(private readonly ctx: AudioContext) {}

  startSegment(): void {
    this.chunks = [];
    this.collecting = true;
  }

  addFrame(data: ArrayBuffer): void {
    if (this.collecting) this.chunks.push(data);
  }

  endSegment(): void {
    if (!this.collecting) return;
    this.collecting = false;
    const total = this.chunks.reduce((n, c) => n + c.byteLength, 0);
    if (!total) return;
    const joined = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      joined.set(new Uint8Array(c), off);
      off += c.byteLength;
    }
    this.chunks = [];
    const epoch = this.epoch;
    // Start decoding now; schedule in arrival order once the previous segment has been scheduled.
    const decoded = this.ctx.decodeAudioData(joined.buffer).catch(() => null);
    this.tail = Promise.all([this.tail, decoded]).then(([, buffer]) => {
      if (!buffer || epoch !== this.epoch) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.ctx.destination);
      const startAt = Math.max(this.ctx.currentTime + 0.02, this.nextTime);
      src.start(startAt);
      this.nextTime = startAt + buffer.duration;
      this.sources.add(src);
      src.onended = () => {
        this.sources.delete(src);
        if (!this.sources.size && epoch === this.epoch) this.onIdle();
      };
    });
  }

  stop(): void {
    this.epoch++;
    this.collecting = false;
    this.chunks = [];
    this.nextTime = 0;
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.tail = Promise.resolve();
  }
}
