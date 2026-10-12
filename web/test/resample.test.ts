import { describe, expect, it } from 'vitest';
import { FRAME_SAMPLES, Framer, Resampler, floatToInt16, int16ToLEBytes } from '../src/voice/resample';

function sine(freq: number, rate: number, n: number, start = 0): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * (i + start)) / rate));
}

describe('Resampler', () => {
  it('48k -> 16k yields one third of the samples', () => {
    const r = new Resampler(48000);
    expect(r.push(new Float32Array(4800)).length).toBe(1600);
  });
  it('44.1k -> 16k yields about 16/44.1 of the input over time', () => {
    const r = new Resampler(44100);
    let out = 0;
    for (let i = 0; i < 100; i++) out += r.push(new Float32Array(1024)).length;
    expect(Math.abs(out - (102400 * 16000) / 44100)).toBeLessThanOrEqual(2);
  });
  it('is chunk-size independent', () => {
    const input = sine(440, 48000, 9600);
    const whole = new Resampler(48000).push(input);
    const r = new Resampler(48000);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 1000) parts.push(...r.push(input.slice(i, i + 1000)));
    expect(parts.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(parts[i]).toBeCloseTo(whole[i]!, 5);
  });
  it('keeps DC level and a 440 Hz tone amplitude roughly intact', () => {
    const dc = new Resampler(48000).push(new Float32Array(480).fill(0.5));
    expect([...dc].every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
    const tone = new Resampler(48000).push(sine(440, 48000, 4800));
    const peak = Math.max(...tone.slice(10).map(Math.abs));
    expect(peak).toBeGreaterThan(0.95);
    expect(peak).toBeLessThanOrEqual(1.0001);
  });
  it('attenuates content above the new Nyquist', () => {
    const hi = new Resampler(48000).push(sine(15000, 48000, 4800));
    expect(Math.max(...hi.slice(10).map(Math.abs))).toBeLessThan(0.5);
  });
  it('passes through when rates match', () => {
    const input = Float32Array.from([0.1, -0.2, 0.3, 0.4]);
    expect([...new Resampler(16000).push(input)]).toEqual([...input]);
  });
});

describe('floatToInt16', () => {
  it('scales and clamps', () => {
    expect([...floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5]))]).toEqual([
      0, 32767, -32768, 32767, -32768, 16384,
    ]);
  });
});

describe('Framer', () => {
  it('emits exact 40 ms frames of 640 samples and keeps the remainder', () => {
    expect(FRAME_SAMPLES).toBe(640);
    const f = new Framer();
    expect(f.push(new Int16Array(500)).length).toBe(0);
    const frames = f.push(new Int16Array(800));
    expect(frames.length).toBe(2);
    expect(frames.every((x) => x.length === 640)).toBe(true);
    expect(f.push(new Int16Array(10)).length).toBe(0); // 1300 - 1280 = 20 pending, then 30 -> still short
  });
  it('wire bytes are little-endian, 1280 per frame', () => {
    const bytes = new Uint8Array(int16ToLEBytes(Int16Array.from([1, -2, 0x1234])));
    expect([...bytes]).toEqual([1, 0, 0xfe, 0xff, 0x34, 0x12]);
    expect(int16ToLEBytes(new Int16Array(FRAME_SAMPLES)).byteLength).toBe(1280);
  });
});
