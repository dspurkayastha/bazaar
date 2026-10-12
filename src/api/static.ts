/**
 * Serves the built web app (web/dist) at `/`, same origin as the API (docs/WEB_API.md):
 *
 *   - files under dist, with `/assets/*` (Vite's content-hashed bundles) cached `public, max-age=31536000, immutable`
 *     and everything else (index.html, manifest, icons) `no-cache`;
 *   - SPA fallback: any other GET that is not /api/* or /voice gets index.html, so client routes like /setup/<code>
 *     and /household load the app;
 *   - unknown /api/* paths answer `{error:{code:'not_found'}}`;
 *   - when dist is missing, `/` answers a short text saying how to build it.
 *
 * The Content-Security-Policy (self only, plus the same host over wss for /voice) and the other security headers are
 * set on every response by `securityHeaders`.
 */
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const NO_CACHE = 'no-cache';

export const NOT_BUILT =
  'Bazaar is running, but the web app is not built.\n\n' +
  'On the server, from the repo root:\n  pnpm web:build   (builds web/ into web/dist)\nthen restart Bazaar (pm2 restart bazaar).\n\n' +
  'The API is at /api and voice at /voice.\n';

/** CSP: only this origin, plus its own host over ws(s) for /voice. */
export function contentSecurityPolicy(origin: string): string {
  const wsOrigin = origin.replace(/^http/, 'ws');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    `connect-src 'self' ${wsOrigin}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "media-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

export function securityHeaders(app: FastifyInstance, origin: string): void {
  const csp = contentSecurityPolicy(origin);
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('content-security-policy', csp);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    return payload;
  });
}

function isApiPath(url: string): boolean {
  return url === '/api' || url.startsWith('/api/') || url === '/voice' || url.startsWith('/voice?');
}

/** Resolve a URL path to a file strictly inside `root`, or undefined. */
function fileFor(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]!);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const rel = path.normalize(decoded).replace(/^([/\\])+/, '');
  if (rel === '' || rel.split(/[/\\]/).some((seg) => seg.startsWith('.'))) return undefined;
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return undefined;
  try {
    return statSync(full).isFile() ? full : undefined;
  } catch {
    return undefined;
  }
}

export function registerWebApp(app: FastifyInstance, distDir: string | undefined): void {
  const root = distDir ? path.resolve(distDir) : undefined;
  const indexPath = root ? path.join(root, 'index.html') : undefined;

  app.setNotFoundHandler(async (req: FastifyRequest, reply: FastifyReply) => {
    if (isApiPath(req.url)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    }
    // Checked per request so a `pnpm web:build` after boot is picked up without a restart.
    if (!indexPath || !existsSync(indexPath)) {
      return reply
        .code(req.url === '/' ? 200 : 404)
        .type('text/plain; charset=utf-8')
        .header('cache-control', NO_CACHE)
        .send(NOT_BUILT);
    }
    const file = fileFor(root!, req.url);
    if (file && file !== indexPath) {
      const rel = path.relative(root!, file).split(path.sep).join('/');
      return reply
        .type(TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
        .header('cache-control', rel.startsWith('assets/') ? IMMUTABLE : NO_CACHE)
        .send(await readFile(file));
    }
    // A missing hashed asset is a real 404 (never the HTML shell under a .js URL).
    if (req.url.startsWith('/assets/')) return reply.code(404).type('text/plain').send('Not found.');
    return reply
      .type(TYPES['.html']!)
      .header('cache-control', NO_CACHE)
      .send(await readFile(indexPath));
  });
}
