/**
 * Browser sessions (docs/WEB_API.md "Identity"): an opaque random token in the `bz_session` cookie
 * (HttpOnly; Secure; SameSite=Strict; Path=/), only sha256(token) stored, 30-day sliding expiry.
 * Also: the setup-link codes (one-time, 48 h, stored hashed) and the cookie helpers.
 */
import { createHash, randomBytes } from 'node:crypto';
import { newId } from '../core/ids.js';
import type { ISODateTime } from '../core/types.js';
import type { IdentityStore, SetupCodeRecord, WebSessionRecord } from './types.js';

export const SESSION_COOKIE = 'bz_session';
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
/** Sliding expiry is written at most this often per session (every request would be a write otherwise). */
export const SESSION_TOUCH_EVERY_MS = 5 * 60_000;
export const SETUP_CODE_TTL_MS = 48 * 3_600_000;

const SESSION_PREFIX = 'bzs_';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 32 random bytes, base64url (43 chars). */
function random32(): string {
  return randomBytes(32).toString('base64url');
}

export function looksLikeSessionToken(t: string): boolean {
  return /^bzs_[A-Za-z0-9_-]{43}$/.test(t);
}

export function looksLikeSetupCode(c: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(c);
}

// ---------- cookies ----------

/** Parse a Cookie header into name → value (first occurrence wins). No decoding beyond trimming. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(token: string, maxAgeMs: number = SESSION_TTL_MS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function sessionTokenFrom(cookieHeader: string | undefined): string | undefined {
  const t = parseCookies(cookieHeader)[SESSION_COOKIE];
  return t && looksLikeSessionToken(t) ? t : undefined;
}

// ---------- sessions ----------

export interface ResolvedSession {
  session: WebSessionRecord;
  /** Set when the expiry slid forward: the caller re-sends the cookie with a fresh Max-Age. */
  refreshed: boolean;
}

export class SessionService {
  constructor(
    private readonly store: IdentityStore,
    private readonly now: () => ISODateTime = () => new Date().toISOString(),
  ) {}

  /** New session for a member; returns the plaintext token for the cookie (never stored). */
  async create(member: { id: string; householdId: string }): Promise<{ token: string; session: WebSessionRecord }> {
    const token = `${SESSION_PREFIX}${random32()}`;
    const at = this.now();
    const session: WebSessionRecord = {
      id: newId('ses'),
      memberId: member.id,
      householdId: member.householdId,
      tokenHash: sha256Hex(token),
      createdAt: at,
      lastSeenAt: at,
      expiresAt: new Date(Date.parse(at) + SESSION_TTL_MS).toISOString(),
    };
    await this.store.createSession(session);
    return { token, session };
  }

  /** The live session for a token, with its expiry slid to now + 30 days. Expired / revoked / unknown → undefined. */
  async resolve(token: string | undefined): Promise<ResolvedSession | undefined> {
    if (!token || !looksLikeSessionToken(token)) return undefined;
    const s = await this.store.findSessionByTokenHash(sha256Hex(token));
    if (!s || s.revokedAt) return undefined;
    const at = this.now();
    const nowMs = Date.parse(at);
    if (Date.parse(s.expiresAt) <= nowMs) return undefined;
    if (nowMs - Date.parse(s.lastSeenAt) < SESSION_TOUCH_EVERY_MS) return { session: s, refreshed: false };
    const expiresAt = new Date(nowMs + SESSION_TTL_MS).toISOString();
    await this.store.touchSession(s.id, at, expiresAt);
    return { session: { ...s, lastSeenAt: at, expiresAt }, refreshed: true };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.store.revokeSession(sessionId, this.now());
  }
}

// ---------- setup links ----------

/**
 * Create a one-time setup link for a member (replaces any unused earlier link). The code is shown once in the URL;
 * only its hash is stored.
 */
export async function createSetupLink(
  store: IdentityStore,
  args: { memberId: string; householdId: string; createdBy?: string; origin: string; now: ISODateTime },
): Promise<{ url: string; expiresAt: ISODateTime }> {
  const code = random32();
  const expiresAt = new Date(Date.parse(args.now) + SETUP_CODE_TTL_MS).toISOString();
  await store.createSetupCode({
    id: newId('sc'),
    memberId: args.memberId,
    householdId: args.householdId,
    codeHash: sha256Hex(code),
    ...(args.createdBy ? { createdBy: args.createdBy } : {}),
    createdAt: args.now,
    expiresAt,
  });
  await store.recordSecurityEvent({
    id: newId('sev'),
    householdId: args.householdId,
    memberId: args.memberId,
    kind: 'setup_link_created',
    at: args.now,
    ...(args.createdBy ? { detail: { by: args.createdBy } } : {}),
  });
  return { url: `${args.origin.replace(/\/+$/, '')}/setup/${code}`, expiresAt };
}

/** The usable setup code record for `code`: known, unused, not revoked, not expired. */
export async function findUsableSetupCode(
  store: IdentityStore,
  code: string,
  now: ISODateTime,
): Promise<SetupCodeRecord | undefined> {
  if (!looksLikeSetupCode(code)) return undefined;
  const rec = await store.findSetupCode(sha256Hex(code));
  if (!rec || rec.usedAt || rec.revokedAt || Date.parse(rec.expiresAt) <= Date.parse(now)) return undefined;
  return rec;
}
