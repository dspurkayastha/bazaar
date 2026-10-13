/**
 * The Cloudflare edge gate (deploy/cloudflare.md). When EDGE_SECRET is set, the only way in is through the Worker
 * that holds the same secret: every request except `/health` must carry `X-Bazaar-Edge: <secret>` or it is answered
 * 403 before routing, rate limiting or authentication (this includes the /voice WebSocket upgrade, which is an
 * ordinary GET until the handler runs). Only a request that passed the gate may name the real client address in
 * `X-Real-IP`; rate limiting keys on that (`clientIp`), never on a header from an ungated caller.
 * Unset = local dev, no gate.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const EDGE_HEADER = 'x-bazaar-edge';

declare module 'fastify' {
  interface FastifyRequest {
    /** The real client address: X-Real-IP when the edge secret matched, else the socket address. */
    clientIp: string;
  }
}

const digest = (s: string) => createHash('sha256').update(s).digest();

export function edgeMatches(secret: string, header: string | string[] | undefined): boolean {
  if (typeof header !== 'string' || header === '') return false;
  return timingSafeEqual(digest(secret), digest(header));
}

export function isHealth(url: string): boolean {
  return url === '/health' || url.startsWith('/health?');
}

export function registerEdgeGate(app: FastifyInstance, secret: string | undefined): void {
  app.decorateRequest('clientIp', '');
  app.addHook('onRequest', async (req, reply) => {
    req.clientIp = req.ip;
    if (!secret) return;
    if (edgeMatches(secret, req.headers[EDGE_HEADER])) {
      const real = req.headers['x-real-ip'];
      if (typeof real === 'string' && isIP(real.trim())) req.clientIp = real.trim();
      return;
    }
    if (isHealth(req.url)) return;
    // A refused WebSocket upgrade is answered on the raw upgrade socket, which nothing else will end: close it.
    if (req.headers.upgrade) reply.raw.once('finish', () => req.raw.socket?.destroySoon());
    return reply.code(403).send({ error: { code: 'forbidden', message: 'Forbidden.' } });
  });
}

export const clientIpOf = (req: FastifyRequest): string => req.clientIp || req.ip;
