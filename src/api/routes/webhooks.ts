/**
 * POST /webhooks/whatsapp { from, body }: the WhatsApp relay posts each inbound message here.
 *
 * Authentication is the relay's signature, not a bearer token: `x-bazaar-signature: sha256=<hex>` is
 * HMAC-SHA256(WHATSAPP_WEBHOOK_SECRET, raw body). It is checked in this route's body parser, on the raw bytes,
 * before the JSON is even parsed; a missing or wrong signature is 401 and nothing runs. Only then is `from` mapped
 * to a member (unknown sender → 403).
 *
 * A webhook request can only create a shop request; it can never approve, and approvals never apply to it. It is
 * HELD (channel_untrusted) for adders and owners alike, unless the sender is an owner whose WhatsApp channel is
 * marked `trusted: true` in Member.channels, in which case the normal policy applies.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { makeRequest, runShopRequest } from '../../agent/loop.js';
import { verifyWebhookSignature } from '../../core/credentials.js';
import { ApiError, body, reqString, type ApiDeps } from '../http.js';

export const SIGNATURE_HEADER = 'x-bazaar-signature';

/** "+91 98765-43210" and "whatsapp:+919876543210" → "+919876543210". */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

const verified = new WeakSet<FastifyRequest>();

export function registerWebhookRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.register(async (scope) => {
    // Every body on this route goes through the signature check on its raw bytes, whatever its content type.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (req, raw, done) => {
      const secret = deps.webhookSecret ?? '';
      if (!secret) return done(new ApiError(503, 'webhook is not configured'), undefined);
      const header = req.headers[SIGNATURE_HEADER];
      if (!verifyWebhookSignature(secret, raw as Buffer, typeof header === 'string' ? header : undefined)) {
        return done(new ApiError(401, 'bad or missing signature'), undefined);
      }
      verified.add(req);
      try {
        done(null, JSON.parse((raw as Buffer).toString('utf8')));
      } catch {
        done(new ApiError(400, 'body must be JSON'), undefined);
      }
    });
    // No body (so no parser run) means no signature was checked: refuse.
    scope.addHook('preHandler', async (req) => {
      if (!verified.has(req)) throw new ApiError(deps.webhookSecret ? 401 : 503, 'bad or missing signature');
    });

    scope.post('/webhooks/whatsapp', { config: { auth: 'webhook' } }, async (req) => {
      const o = body(req.body);
      const from = normalisePhone(reqString(o, 'from', 64));
      const text = reqString(o, 'body', 2000);
      const who = await deps.store.findMemberByChannel('whatsapp', from);
      if (!who) throw new ApiError(403, 'unknown sender');
      const household = await deps.store.loadHousehold(who.householdId);
      const member = household.members.find((m) => m.id === who.memberId);
      const channel = member?.channels.find((c) => c.kind === 'whatsapp' && normalisePhone(c.address) === from);
      const trusted = member?.role === 'owner' && channel?.trusted === true;
      const request = makeRequest(
        { householdId: who.householdId, memberId: who.memberId, text, channel: 'whatsapp' },
        deps.now?.() ?? new Date().toISOString(),
      );
      const result = await runShopRequest(request, deps, { webhook: { channel: 'whatsapp', trusted } });
      return { reply: result.summary, result };
    });
  });
}
