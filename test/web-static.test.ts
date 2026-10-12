/** The built web app served at / : cache headers, SPA fallback, CSP, and the not-built message. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/agent/memory-store.js';
import { buildServer } from '../src/api/server.js';
import { IMMUTABLE, NOT_BUILT, NO_CACHE } from '../src/api/static.js';
import { parsePinThreshold, webConfigFromEnv } from '../src/api/web-config.js';
import { household } from './fixtures/context.js';
import { ScriptedLlm } from './fixtures/llm.js';

const INDEX = '<!doctype html><html><head><script type="module" src="/assets/app-3f9a1c2b.js"></script></head></html>';
let dist: string;
let app: FastifyInstance;

beforeAll(() => {
  dist = mkdtempSync(path.join(tmpdir(), 'bazaar-dist-'));
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'index.html'), INDEX);
  writeFileSync(path.join(dist, 'assets', 'app-3f9a1c2b.js'), 'console.log(1)');
  writeFileSync(path.join(dist, 'manifest.webmanifest'), '{}');
  writeFileSync(path.join(dist, '.env'), 'SECRET=1');
});
afterAll(() => rmSync(dist, { recursive: true, force: true }));
afterEach(async () => {
  await app?.close();
});

function start(distDir: string | undefined, origin = 'https://bazaar.test') {
  const h = household();
  app = buildServer({
    store: new MemoryStore([h]),
    suppliers: [],
    llm: new ScriptedLlm([]),
    apiToken: 'test-token',
    defaultHouseholdId: h.id,
    web: { origin, rpId: new URL(origin).hostname, ...(distDir ? { distDir } : {}) },
  });
}

describe('static web app', () => {
  it('serves index.html at / with no-cache, hashed assets immutable, and a self-only CSP', async () => {
    start(dist);
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toMatch(/^text\/html/);
    expect(root.headers['cache-control']).toBe(NO_CACHE);
    expect(root.body).toBe(INDEX);
    const csp = String(root.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' wss://bazaar.test");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe|\*/);
    expect(root.headers['x-content-type-options']).toBe('nosniff');

    const js = await app.inject({ method: 'GET', url: '/assets/app-3f9a1c2b.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/^text\/javascript/);
    expect(js.headers['cache-control']).toBe(IMMUTABLE);

    const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(manifest.headers['cache-control']).toBe(NO_CACHE);
    expect(manifest.headers['content-type']).toMatch(/manifest\+json/);
  });

  it('SPA fallback for client routes; never for /api, /voice, missing assets, dotfiles or traversal', async () => {
    start(dist);
    for (const url of ['/setup/abc', '/household', '/carts?x=1']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(200);
      expect(r.body).toBe(INDEX);
      expect(r.headers['cache-control']).toBe(NO_CACHE);
    }
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    expect((await app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/household' })).statusCode).toBe(404);
    for (const url of ['/.env', '/..%2f..%2fpackage.json', '/assets/..%2f..%2f.env', '/%2e%2e/%2e%2e/etc/passwd']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.body).not.toContain('SECRET');
      expect(r.body).not.toContain('"name"');
    }
    // the API still works next to the static app
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true });
  });

  it('without a build, / says how to build it', async () => {
    start(path.join(dist, 'nope'));
    const r = await app.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.body).toBe(NOT_BUILT);
    expect(r.body).toContain('pnpm web:build');
    start(undefined);
    expect((await app.inject({ method: 'GET', url: '/' })).body).toBe(NOT_BUILT);
  });

  it('local dev: ws:// for an http origin', async () => {
    start(dist, 'http://localhost:8787');
    const csp = String((await app.inject({ method: 'GET', url: '/' })).headers['content-security-policy']);
    expect(csp).toContain("connect-src 'self' ws://localhost:8787");
  });
});

describe('web config from env', () => {
  it('defaults to localhost; RP id is the origin host; the PIN threshold is ₹500 in paise', () => {
    expect(webConfigFromEnv({})).toEqual({
      origin: 'http://localhost:8787',
      rpId: 'localhost',
      rpName: 'Bazaar',
      distDir: 'web/dist',
    });
    expect(
      webConfigFromEnv({
        WEB_ORIGIN: 'https://bazaar.sciscribesolutions.com/',
        WEBAUTHN_RP_ID: 'bazaar.sciscribesolutions.com',
      }),
    ).toMatchObject({ origin: 'https://bazaar.sciscribesolutions.com', rpId: 'bazaar.sciscribesolutions.com' });
    expect(
      webConfigFromEnv({
        WEB_ORIGIN: 'https://bazaar.sciscribesolutions.com',
        WEBAUTHN_RP_ID: 'sciscribesolutions.com',
      }).rpId,
    ).toBe('sciscribesolutions.com');
    expect(() => webConfigFromEnv({ WEB_ORIGIN: 'https://a.com', WEBAUTHN_RP_ID: 'b.com' })).toThrow(/WEBAUTHN_RP_ID/);
    expect(() => webConfigFromEnv({ WEB_ORIGIN: 'https://a.com/app' })).toThrow(/WEB_ORIGIN/);
    expect(parsePinThreshold(undefined)).toBe(50_000);
    expect(parsePinThreshold('750')).toBe(75_000);
    expect(() => parsePinThreshold('500.5')).toThrow(/whole number/);
  });
});
