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
import { sessionTokenFrom } from '../auth/session.js';
import { BazaarError, SupplierError } from '../core/errors.js';
import { registerVoiceRoute } from '../voice/route.js';
import { authHook } from './auth.js';
import { ApiError, webOf, type ApiDeps } from './http.js';
import { registerApproveRoutes } from './routes/approve.js';
import { registerLedgerRoutes } from './routes/ledger.js';
import { registerPlaceRoutes } from './routes/places.js';
import { registerRequestRoutes } from './routes/request.js';
import { registerWebAuthRoutes } from './routes/web-auth.js';
import { registerWebCartRoutes } from './routes/web-carts.js';
import { registerWebHouseholdRoutes } from './routes/web-household.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerWebApp, securityHeaders } from './static.js';

export type { ApiDeps } from './http.js';

/** HTTP requests per minute per bearer token (per IP without one). */
export const RATE_LIMIT_PER_MINUTE = 60;

/** Rate-limit key: a digest of the bearer credential or web session (never the token itself), else the client IP. */
function rateKey(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  if (auth) return `tok:${createHash('sha256').update(auth).digest('hex').slice(0, 32)}`;
  const session = sessionTokenFrom(req.headers.cookie);
  if (session) return `ses:${createHash('sha256').update(session).digest('hex').slice(0, 32)}`;
  return `ip:${req.ip}`;
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
  app.decorateRequest('webSession', undefined);
  app.register(rateLimit, {
    global: true,
    max: opts.rateLimitMax ?? RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: rateKey,
  });
  app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  const web = webOf(deps);
  securityHeaders(app, web.origin);

  // /api/* answers {error:{code, message}} (docs/WEB_API.md); the v1 routes keep {error: message}.
  app.setErrorHandler((err, req, reply) => {
    const api = req.url.startsWith('/api/');
    const send = (status: number, code: string, message: string, extra?: Record<string, unknown>) =>
      reply.code(status).send(api ? { error: { code, message }, ...extra } : { error: message, ...extra });
    if (err instanceof ApiError) return send(err.status, err.code, err.message, err.extra);
    if (err instanceof BazaarError) {
      if (err.code === 'NOT_FOUND' || err.code === 'UNKNOWN_MEMBER') return send(404, 'not_found', err.message);
      if (err.code === 'PHONE_TAKEN') return send(409, 'phone_taken', err.message);
      if (err instanceof SupplierError) {
        req.log.error({ err }, 'supplier error');
        return send(502, 'supplier_error', err.message);
      }
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return send(
        status,
        status === 429 ? 'rate_limited' : 'bad_request',
        err instanceof Error ? err.message : 'bad request',
      );
    }
    req.log.error({ err }, 'unhandled error');
    return send(500, 'internal', 'internal error');
  });

  // Routes live in one child context registered after the plugins, so every route gets the rate limit first and
  // then authentication (both are route-level onRequest hooks, in that order): floods are cut before any token lookup.
  const auth = authHook(deps, deps.apiToken);
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
    registerWebAuthRoutes(scoped, deps);
    registerWebCartRoutes(scoped, deps);
    registerWebHouseholdRoutes(scoped, deps);
  });
  // The built web app at / (SPA), outside the authenticated context: static files carry no data.
  registerWebApp(app, web.distDir);
  return app;
}
