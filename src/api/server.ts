/**
 * The v1 HTTP API (Fastify). Authentication is per route (src/api/auth.ts): members use their own `mtk_...` token on
 * /request, /approve and /places; BAZAAR_API_TOKEN is only the household read token for /ledger/summary; the
 * WhatsApp webhook is authenticated by an HMAC signature over the raw body; /health is open.
 * Routes live in ./routes; this file wires auth, error mapping and registration.
 */
import { createHash } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { BazaarError, SupplierError } from '../core/errors.js';
import { registerVoiceRoute } from '../voice/route.js';
import { authHook } from './auth.js';
import { ApiError, type ApiDeps } from './http.js';
import { registerApproveRoutes } from './routes/approve.js';
import { registerLedgerRoutes } from './routes/ledger.js';
import { registerPlaceRoutes } from './routes/places.js';
import { registerRequestRoutes } from './routes/request.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

export type { ApiDeps } from './http.js';

/** HTTP requests per minute per bearer token (per IP without one). */
export const RATE_LIMIT_PER_MINUTE = 60;

/** Rate-limit key: a digest of the bearer credential (never the token itself), else the client IP. */
function rateKey(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  return auth ? `tok:${createHash('sha256').update(auth).digest('hex').slice(0, 32)}` : `ip:${req.ip}`;
}

export function buildServer(
  deps: ApiDeps,
  opts: {
    logger?: boolean;
    /** Send pino output here (tests). */
    logStream?: { write(msg: string): void };
    /** Log level with logStream (default info). */
    logLevel?: string;
    /** Requests per minute per token (default 60). */
    rateLimitMax?: number;
  } = {},
): FastifyInstance {
  if (!deps.apiToken) throw new Error('BAZAAR_API_TOKEN is not set; refusing to start an unauthenticated API');

  const logger = opts.logStream ? { level: opts.logLevel ?? 'info', stream: opts.logStream } : (opts.logger ?? false);
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });
  app.decorateRequest('member', undefined);
  app.register(rateLimit, {
    global: true,
    max: opts.rateLimitMax ?? RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: rateKey,
  });
  app.register(websocket, { options: { maxPayload: 64 * 1024 } });

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

  // Routes live in one child context registered after the plugins, so every route gets the rate limit first and
  // then authentication (both are route-level onRequest hooks, in that order): floods are cut before any token lookup.
  const auth = authHook(deps.store, deps.apiToken);
  app.register(async (scoped) => {
    scoped.addHook('onRoute', (route) => {
      const existing =
        route.onRequest === undefined ? [] : Array.isArray(route.onRequest) ? route.onRequest : [route.onRequest];
      route.onRequest = [...existing, auth];
    });
    scoped.get('/health', { config: { auth: 'none', rateLimit: false } }, async () => ({ ok: true }));
    registerRequestRoutes(scoped, deps);
    registerApproveRoutes(scoped, deps);
    registerPlaceRoutes(scoped, deps);
    registerLedgerRoutes(scoped, deps);
    registerWebhookRoutes(scoped, deps);
    registerVoiceRoute(scoped, deps);
  });
  return app;
}
