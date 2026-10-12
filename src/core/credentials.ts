/**
 * Per-member API credentials (review 4h). Each member holds a random bearer token `mtk_<43 base64url chars>`
 * (256 bits). Only sha256(token) is stored; the plaintext is shown once, when it is issued.
 * Identity on /request, /approve and /places comes from this token, never from the request body.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MEMBER_TOKEN_PREFIX = 'mtk_';

export function newMemberToken(): string {
  return `${MEMBER_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** sha256 hex of the token: what the store keeps and looks up. */
export function hashMemberToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Cheap shape check before any lookup. */
export function looksLikeMemberToken(token: string): boolean {
  return /^mtk_[A-Za-z0-9_-]{43}$/.test(token);
}

/** `sha256=<hex>` HMAC-SHA256 of the raw body, as sent in x-bazaar-signature. */
export function webhookSignature(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** Constant-time check of an x-bazaar-signature header against the raw body. */
export function verifyWebhookSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!secret || typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = Buffer.from(webhookSignature(secret, rawBody));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
