/** The Cloudflare edge gate: EDGE_SECRET, X-Bazaar-Edge, X-Real-IP (src/api/edge.ts). */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { MemoryStore } from '../src/agent/memory-store.js';
import { buildServer } from '../src/api/server.js';
import { household } from './fixtures/context.js';
import { ScriptedLlm } from './fixtures/llm.js';

const SECRET = 'edge-secret-for-tests-0123456789';
let app: FastifyInstance;

function start(opts: { edgeSecret?: string; rateLimitMax?: number } = {}) {
  const h = household();
  app = buildServer(
    {
      store: new MemoryStore([h]),
      suppliers: [],
      llm: new ScriptedLlm([]),
      apiToken: 'test-token',
      defaultHouseholdId: h.id,
      web: { origin: 'https://bazaar.test', rpId: 'bazaar.test' },
    },
    opts,
  );
  return app;
}

afterEach(async () => {
  await app?.close();
});

describe('edge gate', () => {
  it('without EDGE_SECRET nothing changes: /api/me is a plain 401', async () => {
    start();
    const r = await app.inject({ method: 'GET', url: '/api/me' });
    expect(r.statusCode).toBe(401);
  });

  it('with EDGE_SECRET: no header, wrong header and empty header are 403, even for unknown paths and the SPA', async () => {
    start({ edgeSecret: SECRET });
    for (const headers of [
      {},
      { 'x-bazaar-edge': 'nope' },
      { 'x-bazaar-edge': SECRET + 'x' },
      { 'x-bazaar-edge': '' },
    ]) {
      for (const url of ['/api/me', '/', '/anything', '/voice']) {
        const r = await app.inject({ method: 'GET', url, headers });
        expect(r.statusCode, `${url} ${JSON.stringify(headers)}`).toBe(403);
        expect(r.json()).toEqual({ error: { code: 'forbidden', message: 'Forbidden.' } });
      }
    }
    const post = await app.inject({ method: 'POST', url: '/api/logout', headers: { 'x-bazaar': '1' } });
    expect(post.statusCode).toBe(403);
  });

  it('/health stays open without the header', async () => {
    start({ edgeSecret: SECRET });
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
  });

  it('the right header reaches Bazaar (401 = not signed in)', async () => {
    start({ edgeSecret: SECRET });
    const r = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-bazaar-edge': SECRET } });
    expect(r.statusCode).toBe(401);
  });

  it('rate limiting keys on X-Real-IP only when the secret matched', async () => {
    start({ edgeSecret: SECRET, rateLimitMax: 2 });
    const hit = (ip: string) =>
      app.inject({ method: 'GET', url: '/api/me', headers: { 'x-bazaar-edge': SECRET, 'x-real-ip': ip } });
    expect((await hit('203.0.113.1')).statusCode).toBe(401);
    expect((await hit('203.0.113.1')).statusCode).toBe(401);
    expect((await hit('203.0.113.1')).statusCode).toBe(429);
    // A different real client has its own bucket.
    expect((await hit('203.0.113.2')).statusCode).toBe(401);
  });

  it('without the gate configured, X-Real-IP is ignored (cannot dodge the limit by spoofing it)', async () => {
    start({ rateLimitMax: 2 });
    const hit = (ip: string) => app.inject({ method: 'GET', url: '/api/me', headers: { 'x-real-ip': ip } });
    expect((await hit('203.0.113.1')).statusCode).toBe(401);
    expect((await hit('203.0.113.2')).statusCode).toBe(401);
    expect((await hit('203.0.113.3')).statusCode).toBe(429);
  });

  it('the /voice upgrade is refused 403 without the header', async () => {
    start({ edgeSecret: SECRET });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const url = `ws://127.0.0.1:${port}/voice`;

    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('unexpected-response', (req, res) => {
        res.resume();
        req.destroy();
        resolve(res.statusCode ?? 0);
      });
      ws.once('open', () => reject(new Error('upgrade should have been refused')));
      ws.once('error', () => {});
    });
    expect(status).toBe(403);
  });

  it('the /voice upgrade with the header reaches the 4401 close', async () => {
    start({ edgeSecret: SECRET });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const url = `ws://127.0.0.1:${port}/voice`;
    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { 'x-bazaar-edge': SECRET } });
      ws.once('close', (c) => resolve(c));
      ws.once('error', reject);
    });
    expect(code).toBe(4401);
  });
});
