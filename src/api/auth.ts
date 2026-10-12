/**
 * API authentication (review 4h; docs/WEB_API.md "Identity"). Kinds of caller, chosen per route with `config.auth`:
 *
 *   member     (default) Authorization: Bearer mtk_... — a member's own credential. The member, and so the household,
 *              comes from the token; request bodies never name who is asking. /request, /approve, /places.
 *   session    the web app: `bz_session` cookie (HttpOnly; Secure; SameSite=Strict), opaque, stored hashed, 30-day
 *              sliding expiry. /api/*.
 *   household  Authorization: Bearer $BAZAAR_API_TOKEN — the household-level read token. /ledger/summary.
 *   webhook    no bearer; the raw body must carry a valid x-bazaar-signature (HMAC-SHA256 with
 *              WHATSAPP_WEBHOOK_SECRET), checked in the route's body parser before anything runs.
 *   none       /health, sign-in and setup routes, static files.
 *
 * CSRF: every non-GET request to /api/* must carry `X-Bazaar: 1` (a custom header a cross-site form cannot send;
 * with SameSite=Strict as the second layer). Checked before authentication.
 *
 * Routes without a config fall back to `member`, so a new route is never accidentally open.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from '../agent/store.js';
import { SessionService, sessionCookie, sessionTokenFrom } from '../auth/session.js';
import type { WebSessionRecord } from '../auth/types.js';
import { hashMemberToken, looksLikeMemberToken, newMemberToken } from '../core/credentials.js';
import { ApiError, type ApiDeps } from './http.js';

export type AuthKind = 'member' | 'session' | 'household' | 'webhook' | 'none';

export interface AuthedMember {
  householdId: string;
  memberId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on member- and session-authenticated routes. */
    member?: AuthedMember;
    /** Set on session-authenticated routes. */
    webSession?: WebSessionRecord;
  }
  interface FastifyContextConfig {
    auth?: AuthKind;
  }
}

/** Issue (or rotate to) a new credential for a member. Returns the plaintext token: show it once, store nothing. */
export async function issueMemberToken(
  store: Pick<Store, 'rotateMemberCredential'>,
  memberId: string,
): Promise<string> {
  const token = newMemberToken();
  await store.rotateMemberCredential(memberId, hashMemberToken(token));
  return token;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** The bearer value, exactly `Bearer <one token>`; anything else (case, extra spaces, other schemes) is refused. */
export function bearerOf(authorization: string | undefined): string | undefined {
  const m = /^Bearer (\S+)$/.exec(authorization ?? '');
  return m?.[1];
}

function bearer(req: FastifyRequest): string | undefined {
  return bearerOf(req.headers.authorization);
}

/**
 * Resolve an `Authorization` header carrying a member token to its member, or undefined. Shared by the HTTP auth
 * hook and the /voice WebSocket upgrade (which must accept the socket and close it with 4401 instead of a 401).
 */
export async function authenticateMember(
  store: Pick<Store, 'findMemberByTokenHash'>,
  authorization: string | undefined,
): Promise<AuthedMember | undefined> {
  const token = bearerOf(authorization);
  if (!token || !looksLikeMemberToken(token)) return undefined;
  return store.findMemberByTokenHash(hashMemberToken(token));
}

export function sessionsOf(deps: Pick<ApiDeps, 'store' | 'now'>): SessionService {
  return new SessionService(deps.store, deps.now);
}

/**
 * Resolve the `bz_session` cookie to its member (sliding the expiry). Shared by the HTTP hook and the /voice upgrade.
 */
export async function authenticateSession(
  deps: Pick<ApiDeps, 'store' | 'now'>,
  cookieHeader: string | undefined,
): Promise<{ who: AuthedMember; session: WebSessionRecord; token: string; refreshed: boolean } | undefined> {
  const token = sessionTokenFrom(cookieHeader);
  if (!token) return undefined;
  const r = await sessionsOf(deps).resolve(token);
  if (!r) return undefined;
  return {
    who: { householdId: r.session.householdId, memberId: r.session.memberId },
    session: r.session,
    token,
    refreshed: r.refreshed,
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** /api/* non-GET without `X-Bazaar: 1` → refused. */
export function failsCsrf(req: FastifyRequest): boolean {
  return req.url.startsWith('/api/') && !SAFE_METHODS.has(req.method) && req.headers['x-bazaar'] !== '1';
}

export function authHook(deps: Pick<ApiDeps, 'store' | 'now'>, householdToken: string) {
  const expected = digest(householdToken);
  const deny = (req: FastifyRequest, reply: FastifyReply) =>
    req.url.startsWith('/api/')
      ? reply.code(401).send({ error: { code: 'unauthorised', message: 'Sign in first.' } })
      : reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorised' });

  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (failsCsrf(req)) {
      return reply.code(403).send({ error: { code: 'csrf', message: 'Missing X-Bazaar header.' } });
    }
    const kind: AuthKind = req.routeOptions.config?.auth ?? 'member';
    if (kind === 'none' || kind === 'webhook') return;
    if (kind === 'session') {
      const s = await authenticateSession(deps, req.headers.cookie);
      if (!s) return deny(req, reply);
      req.member = s.who;
      req.webSession = s.session;
      if (s.refreshed) reply.header('set-cookie', sessionCookie(s.token));
      return;
    }
    const token = bearer(req);
    if (!token) return deny(req, reply);
    if (kind === 'household') {
      if (!timingSafeEqual(digest(token), expected)) return deny(req, reply);
      return;
    }
    const who = await authenticateMember(deps.store, req.headers.authorization);
    if (!who) return deny(req, reply);
    req.member = who;
  };
}

/** The authenticated member; only reachable on member/session routes, so a missing one is a wiring bug → 401. */
export function memberOf(req: FastifyRequest): AuthedMember {
  if (!req.member) throw new ApiError(401, 'unauthorised');
  return req.member;
}
