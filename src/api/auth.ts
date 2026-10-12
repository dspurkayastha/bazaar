/**
 * API authentication (review 4h). Three kinds of caller, chosen per route with `config.auth`:
 *
 *   member     (default) Authorization: Bearer mtk_... — a member's own credential. The member, and so the household,
 *              comes from the token; request bodies never name who is asking. /request, /approve, /places.
 *   household  Authorization: Bearer $BAZAAR_API_TOKEN — the household-level read token. /ledger/summary.
 *   webhook    no bearer; the raw body must carry a valid x-bazaar-signature (HMAC-SHA256 with
 *              WHATSAPP_WEBHOOK_SECRET), checked in the route's body parser before anything runs.
 *   none       /health.
 *
 * Routes without a config fall back to `member`, so a new route is never accidentally open.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from '../agent/store.js';
import { hashMemberToken, looksLikeMemberToken, newMemberToken } from '../core/credentials.js';
import { ApiError } from './http.js';

export type AuthKind = 'member' | 'household' | 'webhook' | 'none';

export interface AuthedMember {
  householdId: string;
  memberId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on member-authenticated routes. */
    member?: AuthedMember;
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

export function authHook(store: Store, householdToken: string) {
  const expected = digest(householdToken);
  const deny = (reply: FastifyReply) =>
    reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorised' });

  return async (req: FastifyRequest, reply: FastifyReply) => {
    const kind: AuthKind = req.routeOptions.config?.auth ?? 'member';
    if (kind === 'none' || kind === 'webhook') return;
    const token = bearer(req);
    if (!token) return deny(reply);
    if (kind === 'household') {
      if (!timingSafeEqual(digest(token), expected)) return deny(reply);
      return;
    }
    const who = await authenticateMember(store, req.headers.authorization);
    if (!who) return deny(reply);
    req.member = who;
  };
}

/** The authenticated member; only reachable on member routes, so a missing one is a wiring bug → 401. */
export function memberOf(req: FastifyRequest): AuthedMember {
  if (!req.member) throw new ApiError(401, 'unauthorised');
  return req.member;
}
