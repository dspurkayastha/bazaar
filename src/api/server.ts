/**
 * The v1 HTTP API (Fastify). Authentication is per route (src/api/auth.ts): members use their own `mtk_...` token on
 * /request, /approve and /places; BAZAAR_API_TOKEN is only the household read token for /ledger/summary; the
 * WhatsApp webhook is authenticated by an HMAC signature over the raw body; /health is open.
 * Routes live in ./routes; this file wires auth, error mapping and registration.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { BazaarError, SupplierError } from '../core/errors.js';
import { authHook } from './auth.js';
import { ApiError, type ApiDeps } from './http.js';
import { registerApproveRoutes } from './routes/approve.js';
import { registerLedgerRoutes } from './routes/ledger.js';
import { registerPlaceRoutes } from './routes/places.js';
import { registerRequestRoutes } from './routes/request.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

export type { ApiDeps } from './http.js';

export function buildServer(deps: ApiDeps, opts: { logger?: boolean } = {}): FastifyInstance {
  if (!deps.apiToken) throw new Error('BAZAAR_API_TOKEN is not set; refusing to start an unauthenticated API');

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });
  app.decorateRequest('member', undefined);
  app.addHook('onRequest', authHook(deps.store, deps.apiToken));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof BazaarError) {
      if (err.code === 'NOT_FOUND' || err.code === 'UNKNOWN_MEMBER')
        return reply.code(404).send({ error: err.message });
      if (err instanceof SupplierError) {
        req.log.error({ err }, 'supplier error');
        return reply.code(502).send({ error: err.message });
      }
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: err instanceof Error ? err.message : 'bad request' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal error' });
  });

  app.get('/health', { config: { auth: 'none' } }, async () => ({ ok: true }));
  registerRequestRoutes(app, deps);
  registerApproveRoutes(app, deps);
  registerPlaceRoutes(app, deps);
  registerLedgerRoutes(app, deps);
  registerWebhookRoutes(app, deps);
  return app;
}
