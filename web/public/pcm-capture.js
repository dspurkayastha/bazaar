// AudioWorklet: gathers mic samples (mono, at the context's native rate) and posts them in ~21 ms blocks.
// Resampling to 16 kHz and 40 ms framing happen on the main thread (src/voice/resample.ts) so they can be tested.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1024);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, this.block.length - this.n);
      this.block.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.block.length) {
        const out = this.block;
        this.port.postMessage(out, [out.buffer]);
        this.block = new Float32Array(1024);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
