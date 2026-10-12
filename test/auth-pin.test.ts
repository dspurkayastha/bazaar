import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/agent/memory-store.js';
import {
  PIN_LOCK_MS,
  PIN_PROOF_TTL_MS,
  PinService,
  consumePinProof,
  hashPin,
  isValidPin,
  verifyPinHash,
  type PinProof,
} from '../src/auth/pin.js';
import { household, owner } from './fixtures/context.js';

function setup() {
  const h = household();
  const store = new MemoryStore([h]);
  let now = Date.parse('2026-10-12T10:00:00.000Z');
  const clock = { iso: () => new Date(now).toISOString(), ms: () => now, advance: (ms: number) => (now += ms) };
  const pins = new PinService(store, clock.iso);
  return { h, store, pins, clock, dev: owner(h) };
}

describe('PIN hashing', () => {
  it('scrypt N=2^15 r=8 p=1 with a per-PIN salt; constant-time verify', async () => {
    const a = await hashPin('482913');
    const b = await hashPin('482913');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b); // different salts
    expect(a).not.toContain('482913');
    expect(await verifyPinHash('482913', a)).toBe(true);
    expect(await verifyPinHash('482914', a)).toBe(false);
    expect(await verifyPinHash('48291', a)).toBe(false);
    expect(await verifyPinHash('482913', 'garbage')).toBe(false);
  });

  it('PINs are 4 to 6 digits', () => {
    for (const ok of ['1234', '12345', '123456']) expect(isValidPin(ok)).toBe(true);
    for (const bad of ['123', '1234567', '12a4', ' 1234', '', 1234, null]) expect(isValidPin(bad)).toBe(false);
  });
});

describe('PinService lockout (fake clock)', () => {
  it('5 wrong → locked for exactly 15 minutes, event recorded, attempts while locked are not counted', async () => {
    const { store, pins, clock, dev } = setup();
    await pins.setPin(dev, '2468');
    for (let i = 1; i <= 4; i++) {
      const r = await pins.verifyPinForApproval(dev.id, '0000');
      expect(r).toMatchObject({ ok: false, reason: 'incorrect', attemptsLeft: 5 - i });
    }
    const fifth = await pins.verifyPinForApproval(dev.id, '0000');
    expect(fifth).toMatchObject({ ok: false, reason: 'incorrect', attemptsLeft: 0, lockedNow: { locked: true } });
    // even the right PIN is refused while locked
    expect(await pins.verifyPinForApproval(dev.id, '2468')).toMatchObject({
      ok: false,
      reason: 'locked',
      lock: { hard: false },
    });
    expect((await store.getPin(dev.id))!.failures).toHaveLength(5);
    expect(store.securityEvents.map((e) => e.kind)).toEqual(['pin_set', 'pin_locked']);
    expect(JSON.stringify(store.securityEvents)).not.toContain('2468');

    clock.advance(PIN_LOCK_MS - 1);
    expect((await pins.verifyPinForApproval(dev.id, '2468')).ok).toBe(false);
    clock.advance(1);
    expect((await pins.verifyPinForApproval(dev.id, '2468')).ok).toBe(true);
    expect(await pins.status(dev.id)).toEqual({ pinSet: true, pinLocked: false });
  });

  it('10 wrong within 24 h → locked until reset; a reset (new PIN) clears it', async () => {
    const { store, pins, clock, dev } = setup();
    await pins.setPin(dev, '2468');
    for (let i = 0; i < 5; i++) await pins.verifyPinForApproval(dev.id, '1111');
    clock.advance(PIN_LOCK_MS);
    for (let i = 0; i < 4; i++)
      expect(await pins.verifyPinForApproval(dev.id, '1111')).toMatchObject({ reason: 'incorrect' });
    const tenth = await pins.verifyPinForApproval(dev.id, '1111');
    expect(tenth).toMatchObject({ reason: 'incorrect', lockedNow: { locked: true, hard: true } });
    clock.advance(48 * 3_600_000);
    expect(await pins.verifyPinForApproval(dev.id, '2468')).toMatchObject({ reason: 'locked', lock: { hard: true } });
    expect(await pins.status(dev.id)).toMatchObject({ pinSet: true, pinLocked: true, hardLocked: true });
    expect(store.securityEvents.map((e) => e.kind)).toEqual(['pin_set', 'pin_locked', 'pin_hard_locked']);

    await pins.setPin(dev, '97531');
    expect(await pins.status(dev.id)).toEqual({ pinSet: true, pinLocked: false });
    expect((await pins.verifyPinForApproval(dev.id, '97531')).ok).toBe(true);
    expect(store.securityEvents.at(-1)).toMatchObject({ kind: 'pin_reset', detail: { wasLocked: true } });
  });

  it('wrong PINs older than 24 h do not count toward the hard lock; a success resets the consecutive count', async () => {
    const { pins, clock, dev } = setup();
    await pins.setPin(dev, '2468');
    for (let i = 0; i < 4; i++) await pins.verifyPinForApproval(dev.id, '1111');
    expect((await pins.verifyPinForApproval(dev.id, '2468')).ok).toBe(true);
    for (let i = 0; i < 4; i++) await pins.verifyPinForApproval(dev.id, '1111'); // 8 in 24 h, never 5 in a row
    expect(await pins.status(dev.id)).toMatchObject({ pinLocked: false });
    expect((await pins.verifyPinForApproval(dev.id, '2468')).ok).toBe(true);
    clock.advance(24 * 3_600_000 + 1);
    // 12 wrong in all, but only these 4 are within 24 h
    for (let i = 0; i < 4; i++) await pins.verifyPinForApproval(dev.id, '1111');
    expect(await pins.status(dev.id)).toMatchObject({ pinLocked: false });
    expect((await pins.verifyPinForApproval(dev.id, '2468')).ok).toBe(true);
  });

  it('parallel guesses are serialised: a burst of 20 cannot get past the 5-attempt lock', async () => {
    const { pins, dev } = setup();
    await pins.setPin(dev, '2468');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => pins.verifyPinForApproval(dev.id, String(1000 + i))),
    );
    expect(results.filter((r) => !r.ok && r.reason === 'incorrect')).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.reason === 'locked')).toHaveLength(15);
  });

  it('not set, malformed input', async () => {
    const { pins, dev } = setup();
    expect(await pins.verifyPinForApproval(dev.id, '1234')).toEqual({ ok: false, reason: 'not_set' });
    await pins.setPin(dev, '2468');
    expect(await pins.verifyPinForApproval(dev.id, '12')).toEqual({ ok: false, reason: 'invalid' });
    await expect(pins.setPin(dev, '12')).rejects.toThrow(/4 to 6 digits/);
  });

  it('a PIN proof is single use, member-bound, short-lived and cannot be forged', async () => {
    const { pins, clock, dev, h } = setup();
    await pins.setPin(dev, '2468');
    const ok = await pins.verifyPinForApproval(dev.id, '2468');
    if (!ok.ok) throw new Error('expected ok');
    const partner = h.members.find((m) => m.role === 'adder')!;
    expect(consumePinProof(ok.proof, partner.id, clock.ms())).toBe(false); // wrong member also burns it
    expect(consumePinProof(ok.proof, dev.id, clock.ms())).toBe(false);

    const again = await pins.verifyPinForApproval(dev.id, '2468');
    if (!again.ok) throw new Error('expected ok');
    expect(consumePinProof(again.proof, dev.id, clock.ms() + PIN_PROOF_TTL_MS)).toBe(false);

    const third = await pins.verifyPinForApproval(dev.id, '2468');
    if (!third.ok) throw new Error('expected ok');
    expect(consumePinProof(third.proof, dev.id, clock.ms())).toBe(true);
    expect(consumePinProof(third.proof, dev.id, clock.ms())).toBe(false);

    const forged: PinProof = { memberId: dev.id, verifiedAtMs: clock.ms() };
    expect(consumePinProof(forged, dev.id, clock.ms())).toBe(false);
  });
});
