/**
 * The owner's approval PIN (docs/WEB_API.md "PIN").
 *
 *   - 4–6 digits, stored as scrypt (N=2^15, r=8, p=1, 16-byte per-PIN salt, 32-byte key); compared in constant time.
 *     Never logged, never returned, never put in an error message.
 *   - Lockout: 5 consecutive wrong PINs → PIN approvals disabled for 15 min (event `pin_locked`); 10 wrong within a
 *     rolling 24 h → disabled until the owner sets a new PIN with a fresh passkey assertion (`pin_hard_locked`).
 *     While locked, attempts are refused without being checked or counted.
 *   - `verifyPinForApproval(memberId, digits)` is the one entry point for approvals on every channel: the web approve
 *     route calls it through the approval service, and the telephony adapter (keypad / DTMF) will call it directly.
 *     On success it returns a single-use PinProof that the approval service accepts for up to PIN_PROOF_TTL_MS.
 *   - Checks for one member are serialised in-process (one PM2 fork: deploy/ecosystem.config.cjs), so a burst of
 *     parallel guesses is counted one by one and cannot slip past the lock.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { newId } from '../core/ids.js';
import type { ISODateTime } from '../core/types.js';
import type { IdentityStore, PinRecord, SecurityEventKind } from './types.js';

export const PIN_SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;
/** scrypt needs 128·N·r bytes (32 MiB here); Node's default maxmem is exactly 32 MiB, so give it headroom. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export const PIN_LOCK_AFTER = 5;
export const PIN_LOCK_MS = 15 * 60_000;
export const PIN_HARD_LOCK_AFTER = 10;
export const PIN_HARD_WINDOW_MS = 24 * 3_600_000;
/** How long a verified PIN may be turned into an approval. */
export const PIN_PROOF_TTL_MS = 60_000;

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin);
}

function scrypt(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** `scrypt$N$r$p$<salt base64>$<key base64>` */
export async function hashPin(pin: string): Promise<string> {
  if (!isValidPin(pin)) throw new Error('PIN must be 4 to 6 digits');
  const { N, r, p, keyLen, saltLen } = PIN_SCRYPT;
  const salt = randomBytes(saltLen);
  const key = await scrypt(pin, salt, keyLen, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPinHash(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  // Always run the KDF (even for a malformed PIN) so timing does not depend on the input's shape.
  const key = await scrypt(isValidPin(pin) ? pin : '', salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return isValidPin(pin) && key.length === expected.length && timingSafeEqual(key, expected);
}

// ---------- lockout (pure) ----------

export type PinLock = { locked: false } | { locked: true; hard: boolean; until?: ISODateTime };

export function pinLock(rec: PinRecord | undefined, now: ISODateTime): PinLock {
  if (!rec) return { locked: false };
  if (rec.hardLockedAt) return { locked: true, hard: true };
  if (rec.lockedUntil && Date.parse(rec.lockedUntil) > Date.parse(now))
    return { locked: true, hard: false, until: rec.lockedUntil };
  return { locked: false };
}

/** A wrong PIN: count it, and lock when a threshold is reached. */
export function afterFailure(
  rec: PinRecord,
  now: ISODateTime,
): { rec: PinRecord; event?: 'pin_locked' | 'pin_hard_locked' } {
  const since = Date.parse(now) - PIN_HARD_WINDOW_MS;
  const failures = [...rec.failures.filter((f) => Date.parse(f) > since), now];
  const next: PinRecord = { ...rec, failures, consecutive: rec.consecutive + 1 };
  delete next.lockedUntil;
  if (failures.length >= PIN_HARD_LOCK_AFTER) {
    next.hardLockedAt = now;
    next.consecutive = 0;
    return { rec: next, event: 'pin_hard_locked' };
  }
  if (next.consecutive >= PIN_LOCK_AFTER) {
    next.lockedUntil = new Date(Date.parse(now) + PIN_LOCK_MS).toISOString();
    next.consecutive = 0;
    return { rec: next, event: 'pin_locked' };
  }
  return { rec: next };
}

/** A right PIN: the consecutive count starts over (the 24 h window keeps its failures). */
export function afterSuccess(rec: PinRecord, now: ISODateTime): PinRecord {
  const since = Date.parse(now) - PIN_HARD_WINDOW_MS;
  const next: PinRecord = { ...rec, consecutive: 0, failures: rec.failures.filter((f) => Date.parse(f) > since) };
  delete next.lockedUntil;
  return next;
}

// ---------- proofs ----------

/**
 * Evidence that this member typed the right PIN a moment ago. Only this module creates them (they are tracked in a
 * private WeakSet, so a look-alike object is refused) and each one is accepted once.
 */
export interface PinProof {
  readonly memberId: string;
  readonly verifiedAtMs: number;
}
const liveProofs = new WeakSet<PinProof>();

export function consumePinProof(proof: PinProof, memberId: string, nowMs: number): boolean {
  if (!liveProofs.has(proof)) return false;
  liveProofs.delete(proof);
  return proof.memberId === memberId && nowMs - proof.verifiedAtMs >= 0 && nowMs - proof.verifiedAtMs < PIN_PROOF_TTL_MS;
}

export type PinVerification =
  | { ok: true; proof: PinProof }
  | { ok: false; reason: 'not_set' | 'invalid' }
  | { ok: false; reason: 'incorrect'; attemptsLeft: number; lockedNow?: PinLock }
  | { ok: false; reason: 'locked'; lock: Extract<PinLock, { locked: true }> };

export interface PinStatus {
  pinSet: boolean;
  pinLocked: boolean;
  lockedUntil?: ISODateTime;
  hardLocked?: boolean;
}

// ---------- service ----------

export class PinService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: IdentityStore,
    private readonly now: () => ISODateTime = () => new Date().toISOString(),
  ) {}

  /** Run `fn` after every earlier PIN operation for this member has finished. */
  private serial<T>(memberId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(memberId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.queues.set(memberId, tail);
    void tail.then(() => {
      if (this.queues.get(memberId) === tail) this.queues.delete(memberId);
    });
    return run;
  }

  private async event(
    rec: Pick<PinRecord, 'memberId' | 'householdId'>,
    kind: SecurityEventKind,
    at: ISODateTime,
    detail?: Record<string, string | number | boolean>,
  ): Promise<void> {
    await this.store.recordSecurityEvent({
      id: newId('sev'),
      householdId: rec.householdId,
      memberId: rec.memberId,
      kind,
      at,
      ...(detail ? { detail } : {}),
    });
  }

  async status(memberId: string): Promise<PinStatus> {
    const rec = await this.store.getPin(memberId);
    const lock = pinLock(rec, this.now());
    return {
      pinSet: rec !== undefined,
      pinLocked: lock.locked,
      ...(lock.locked && lock.until ? { lockedUntil: lock.until } : {}),
      ...(lock.locked && lock.hard ? { hardLocked: true } : {}),
    };
  }

  /**
   * Set (or reset) the member's PIN. The CALLER must already have verified a fresh passkey assertion for this member
   * in the same request (POST /api/pin). Clears every lock and failure count.
   */
  setPin(member: { id: string; householdId: string }, pin: string): Promise<void> {
    if (!isValidPin(pin)) return Promise.reject(new Error('PIN must be 4 to 6 digits'));
    return this.serial(member.id, async () => {
      const at = this.now();
      const prev = await this.store.getPin(member.id);
      const hash = await hashPin(pin);
      await this.store.savePin({
        memberId: member.id,
        householdId: member.householdId,
        hash,
        setAt: at,
        failures: [],
        consecutive: 0,
      });
      await this.event(
        { memberId: member.id, householdId: member.householdId },
        prev ? 'pin_reset' : 'pin_set',
        at,
        prev ? { wasLocked: pinLock(prev, at).locked } : undefined,
      );
    });
  }

  /** Check a PIN typed for an approval (web PIN pad or phone keypad). Wrong guesses count toward the lockout. */
  verifyPinForApproval(memberId: string, digits: string): Promise<PinVerification> {
    return this.serial(memberId, async (): Promise<PinVerification> => {
      const at = this.now();
      const rec = await this.store.getPin(memberId);
      if (!rec) return { ok: false, reason: 'not_set' };
      const lock = pinLock(rec, at);
      if (lock.locked) return { ok: false, reason: 'locked', lock };
      if (!isValidPin(digits)) return { ok: false, reason: 'invalid' };
      if (await verifyPinHash(digits, rec.hash)) {
        await this.store.savePin(afterSuccess(rec, at));
        const proof: PinProof = Object.freeze({ memberId, verifiedAtMs: Date.parse(at) });
        liveProofs.add(proof);
        return { ok: true, proof };
      }
      const { rec: next, event } = afterFailure(rec, at);
      await this.store.savePin(next);
      if (event) {
        await this.event(rec, event, at, {
          failures24h: next.failures.length,
          ...(next.lockedUntil ? { lockedUntil: next.lockedUntil } : {}),
        });
      }
      const lockedNow = pinLock(next, at);
      const attemptsLeft = lockedNow.locked
        ? 0
        : Math.min(PIN_LOCK_AFTER - next.consecutive, PIN_HARD_LOCK_AFTER - next.failures.length);
      return { ok: false, reason: 'incorrect', attemptsLeft, ...(lockedNow.locked ? { lockedNow } : {}) };
    });
  }
}

/** One PinService per store, so every route and the voice gateway share the per-member serialisation. */
const services = new WeakMap<object, PinService>();
export function pinServiceFor(store: IdentityStore, now?: () => ISODateTime): PinService {
  let s = services.get(store);
  if (!s) {
    s = new PinService(store, now);
    services.set(store, s);
  }
  return s;
}
