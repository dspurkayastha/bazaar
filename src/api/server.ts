/**
 * The v1 HTTP API (Fastify). One bearer token from BAZAAR_API_TOKEN guards everything except GET /health.
 * Routes live in ./routes; this file wires auth, error mapping and registration.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { BazaarError, SupplierError } from '../core/errors.js';
import { ApiError, type ApiDeps } from './http.js';
import { registerApproveRoutes } from './routes/approve.js';
import { registerLedgerRoutes } from './routes/ledger.js';
import { registerPlaceRoutes } from './routes/places.js';
import { registerRequestRoutes } from './routes/request.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

export type { ApiDeps } from './http.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

export function buildServer(deps: ApiDeps, opts: { logger?: boolean } = {}): FastifyInstance {
  if (!deps.apiToken) throw new Error('BAZAAR_API_TOKEN is not set; refusing to start an unauthenticated API');
  const expected = digest(deps.apiToken);

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    const header = req.headers.authorization ?? '';
    const m = /^Bearer (.+)$/.exec(header);
    if (!m || !timingSafeEqual(digest(m[1]!), expected)) {
      return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorised' });
    }
  });

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

  app.get('/health', async () => ({ ok: true }));
  registerRequestRoutes(app, deps);
  registerApproveRoutes(app, deps);
  registerPlaceRoutes(app, deps);
  registerLedgerRoutes(app, deps);
  registerWebhookRoutes(app, deps);
  return app;
}
