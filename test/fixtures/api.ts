/** Helpers for API tests: member credentials and signed webhook bodies. */
import type { Store } from '../../src/agent/store.js';
import { issueMemberToken } from '../../src/api/auth.js';
import { webhookSignature } from '../../src/core/credentials.js';
import type { Member } from '../../src/core/types.js';

export const WEBHOOK_SECRET = 'test-webhook-secret';

/** Issue a fresh credential for the member and return the Authorization header that carries it. */
export async function memberAuth(store: Store, member: Member): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await issueMemberToken(store, member.id)}` };
}

/** A webhook body as the relay sends it: raw JSON plus x-bazaar-signature over exactly those bytes. */
export function signed(payload: unknown, secret: string = WEBHOOK_SECRET) {
  const raw = JSON.stringify(payload);
  return {
    payload: raw,
    headers: { 'content-type': 'application/json', 'x-bazaar-signature': webhookSignature(secret, raw) },
  };
}
