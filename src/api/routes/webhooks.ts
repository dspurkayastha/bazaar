/**
 * POST /webhooks/whatsapp { from, body }: stub for the WhatsApp provider. Maps a message to a ShopRequest with the
 * member resolved by channel address (E.164). Unknown senders get 403 and nothing runs. Real provider signature
 * verification replaces the bearer check when this is wired to WhatsApp Cloud API.
 */
import type { FastifyInstance } from 'fastify';
import { makeRequest, runShopRequest } from '../../agent/loop.js';
import { ApiError, body, reqString, type ApiDeps } from '../http.js';

/** "+91 98765-43210" and "whatsapp:+919876543210" → "+919876543210". */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export function registerWebhookRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/webhooks/whatsapp', async (req) => {
    const o = body(req.body);
    const from = normalisePhone(reqString(o, 'from', 64));
    const text = reqString(o, 'body', 2000);
    const who = await deps.store.findMemberByChannel('whatsapp', from);
    if (!who) throw new ApiError(403, 'unknown sender');
    const request = makeRequest(
      { householdId: who.householdId, memberId: who.memberId, text, channel: 'whatsapp' },
      deps.now?.() ?? new Date().toISOString(),
    );
    const result = await runShopRequest(request, deps);
    return { reply: result.summary, result };
  });
}
