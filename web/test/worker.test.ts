// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { handle, splice, type EdgeSocket, type Env, type Runtime } from '../worker/index';

const env: Env = {
  ASSETS: { fetch: async () => new Response('asset') },
  PRODUCTION_HOST: 'bazaar.sciscribesolutions.com',
  ORIGIN_URL: 'https://bazaar-origin.sciscribesolutions.com',
  EDGE_SECRET: 'edge-secret-value',
};

const PROD = `https://${env.PRODUCTION_HOST}`;

function recorder(reply: () => Response | Promise<Response> = () => new Response('{}', { status: 200 })) {
  const seen: Request[] = [];
  const fetchImpl = async (req: Request) => {
    seen.push(req);
    return reply();
  };
  return { seen, fetchImpl };
}

describe('preview hosts have no API', () => {
  for (const host of ['feature-x-bazaar-web.dspurkayastha.workers.dev', 'bazaar-web.dspurkayastha.workers.dev']) {
    for (const path of ['/api/me', '/api/carts/abc/approve', '/voice']) {
      it(`${host}${path} -> 404 JSON, no fetch`, async () => {
        const { seen, fetchImpl } = recorder();
        const r = await handle(new Request(`https://${host}${path}`), env, fetchImpl);
        expect(r.status).toBe(404);
        expect(await r.json()).toEqual({ error: { code: 'preview', message: 'Previews have no API' } });
        expect(seen).toHaveLength(0);
      });
    }
  }

  it('a look-alike host is not production', async () => {
    const { seen, fetchImpl } = recorder();
    const r = await handle(new Request(`https://bazaar.sciscribesolutions.com.evil.test/api/me`), env, fetchImpl);
    expect(r.status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});

describe('production forwarding', () => {
  it('keeps path, query, method and body; targets the origin host', async () => {
    const { seen, fetchImpl } = recorder();
    await handle(
      new Request(`${PROD}/api/carts/h%2F1/approve?month=2026-10`, {
        method: 'POST',
        body: JSON.stringify({ pin: '1234' }),
        headers: { 'content-type': 'application/json', 'x-bazaar': '1' },
      }),
      env,
      fetchImpl,
    );
    expect(seen).toHaveLength(1);
    const out = seen[0]!;
    expect(out.method).toBe('POST');
    expect(out.url).toBe('https://bazaar-origin.sciscribesolutions.com/api/carts/h%2F1/approve?month=2026-10');
    expect(await out.text()).toBe('{"pin":"1234"}');
    expect(out.headers.get('content-type')).toBe('application/json');
    expect(out.headers.get('x-bazaar')).toBe('1');
  });

  it('GET has no body', async () => {
    const { seen, fetchImpl } = recorder();
    await handle(new Request(`${PROD}/api/me`), env, fetchImpl);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.body).toBeNull();
  });

  it('passes Cookie, Origin and Authorization through', async () => {
    const { seen, fetchImpl } = recorder();
    await handle(
      new Request(`${PROD}/api/me`, {
        headers: { cookie: 'bz_session=abc', origin: PROD, authorization: 'Bearer mtk_x' },
      }),
      env,
      fetchImpl,
    );
    const h = seen[0]!.headers;
    expect(h.get('cookie')).toBe('bz_session=abc');
    expect(h.get('origin')).toBe(PROD);
    expect(h.get('authorization')).toBe('Bearer mtk_x');
  });

  it('injects X-Bazaar-Edge and the forwarded headers; client-supplied copies are dropped', async () => {
    const { seen, fetchImpl } = recorder();
    await handle(
      new Request(`${PROD}/api/me`, {
        headers: {
          'x-bazaar-edge': 'attacker-guess',
          'x-real-ip': '6.6.6.6',
          'x-forwarded-for': '6.6.6.6',
          'x-forwarded-host': 'evil.test',
          'x-forwarded-proto': 'http',
          'cf-connecting-ip': '203.0.113.9',
        },
      }),
      env,
      fetchImpl,
    );
    const h = seen[0]!.headers;
    expect(h.get('x-bazaar-edge')).toBe('edge-secret-value');
    expect(h.get('x-real-ip')).toBe('203.0.113.9');
    expect(h.get('x-forwarded-host')).toBe(env.PRODUCTION_HOST);
    expect(h.get('x-forwarded-proto')).toBe('https');
    expect(h.get('x-forwarded-for')).toBeNull();
  });

  it('without CF-Connecting-IP there is no X-Real-IP (a client-supplied one never survives)', async () => {
    const { seen, fetchImpl } = recorder();
    await handle(new Request(`${PROD}/api/me`, { headers: { 'x-real-ip': '6.6.6.6' } }), env, fetchImpl);
    expect(seen[0]!.headers.get('x-real-ip')).toBeNull();
  });

  it('returns the origin response untouched, Set-Cookie included', async () => {
    const cookie = 'bz_session=tok; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000';
    const { fetchImpl } = recorder(
      () =>
        new Response('{"ok":true}', {
          status: 201,
          headers: { 'set-cookie': cookie, 'content-type': 'application/json' },
        }),
    );
    const r = await handle(new Request(`${PROD}/api/login/verify`, { method: 'POST', body: '{}' }), env, fetchImpl);
    expect(r.status).toBe(201);
    expect(r.headers.get('set-cookie')).toBe(cookie);
    expect(await r.text()).toBe('{"ok":true}');
  });

  it('passes origin errors through (401 stays 401)', async () => {
    const { fetchImpl } = recorder(() => new Response('{"error":{"code":"unauthorised"}}', { status: 401 }));
    expect((await handle(new Request(`${PROD}/api/me`), env, fetchImpl)).status).toBe(401);
  });

  it('an unreachable origin is a 502 JSON without leaking anything', async () => {
    const r = await handle(new Request(`${PROD}/api/me`), env, async () => {
      throw new Error('connect failed edge-secret-value');
    });
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain('edge-secret-value');
  });

  it('anything else goes to the static assets', async () => {
    const { seen, fetchImpl } = recorder();
    const r = await handle(new Request(`${PROD}/household`), env, fetchImpl);
    expect(await r.text()).toBe('asset');
    expect(seen).toHaveLength(0);
  });
});

describe('WebSocket upgrade', () => {
  const upgrade = () =>
    new Request(`${PROD}/voice`, {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        'sec-websocket-protocol': 'bazaar',
        origin: PROD,
        cookie: 'bz_session=abc',
      },
    });

  const sw = { status: 101, headers: new Headers(), webSocket: {} } as unknown as Response;

  it('forwards the upgrade headers with the edge secret and returns the 101 as is', async () => {
    const { seen, fetchImpl } = recorder(() => sw);
    const r = await handle(upgrade(), env, fetchImpl);
    expect(r).toBe(sw);
    expect(r.status).toBe(101);
    const out = seen[0]!;
    expect(out.url).toBe('https://bazaar-origin.sciscribesolutions.com/voice');
    expect(out.method).toBe('GET');
    expect(out.headers.get('upgrade')).toBe('websocket');
    expect(out.headers.get('sec-websocket-key')).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    expect(out.headers.get('sec-websocket-version')).toBe('13');
    expect(out.headers.get('sec-websocket-protocol')).toBe('bazaar');
    expect(out.headers.get('origin')).toBe(PROD);
    expect(out.headers.get('cookie')).toBe('bz_session=abc');
    expect(out.headers.get('x-bazaar-edge')).toBe('edge-secret-value');
  });

  it('a refused upgrade (403 from the origin) reaches the browser as 403', async () => {
    const { fetchImpl } = recorder(() => new Response('{}', { status: 403 }));
    expect((await handle(upgrade(), env, fetchImpl)).status).toBe(403);
  });
});

class FakeSocket implements EdgeSocket {
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  accepted = false;
  private handlers: Record<string, ((ev: never) => void)[]> = {};
  accept() {
    this.accepted = true;
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  addEventListener(type: string, fn: (ev: never) => void) {
    (this.handlers[type] ??= []).push(fn);
  }
  emit(type: string, ev: unknown) {
    for (const fn of this.handlers[type] ?? []) fn(ev as never);
  }
}

describe('WS_MODE=splice', () => {
  const setup = () => {
    const client = new FakeSocket();
    const server = new FakeSocket();
    const upstream = new FakeSocket();
    const rt: Runtime = {
      newPair: () => ({ client, server }),
      switching: (c) => ({ status: 101, webSocket: c }) as unknown as Response,
    };
    return { client, server, upstream, rt };
  };

  it('pipes messages both ways', () => {
    const { client, server, upstream, rt } = setup();
    const r = splice(upstream, rt);
    expect((r as unknown as { webSocket: unknown }).webSocket).toBe(client);
    expect(server.accepted && upstream.accepted).toBe(true);
    server.emit('message', { data: '{"type":"hello"}' });
    upstream.emit('message', { data: '{"type":"ready"}' });
    expect(upstream.sent).toEqual(['{"type":"hello"}']);
    expect(server.sent).toEqual(['{"type":"ready"}']);
  });

  it('propagates 4401, 4409 and 1011 to the browser unchanged, and maps unsendable codes to 1000', () => {
    for (const code of [4401, 4409, 1011]) {
      const { server, upstream, rt } = setup();
      splice(upstream, rt);
      upstream.emit('close', { code, reason: 'why' });
      expect(server.closed).toEqual({ code, reason: 'why' });
    }
    const { server, upstream, rt } = setup();
    splice(upstream, rt);
    upstream.emit('close', { code: 1006, reason: '' });
    expect(server.closed?.code).toBe(1000);
  });

  it('a browser close reaches the origin', () => {
    const { server, upstream, rt } = setup();
    splice(upstream, rt);
    server.emit('close', { code: 1000, reason: 'bye' });
    expect(upstream.closed).toEqual({ code: 1000, reason: 'bye' });
  });

  it('handle() splices only when WS_MODE=splice and the origin gave a 101 with a socket', async () => {
    const upstream = new FakeSocket();
    const resp = { status: 101, headers: new Headers(), webSocket: upstream } as unknown as Response;
    const { client, rt } = setup();
    const r = await handle(
      new Request(`${PROD}/voice`, { headers: { upgrade: 'websocket' } }),
      { ...env, WS_MODE: 'splice' },
      async () => resp,
      rt,
    );
    expect((r as unknown as { webSocket: unknown }).webSocket).toBe(client);
    const plain = await handle(
      new Request(`${PROD}/voice`, { headers: { upgrade: 'websocket' } }),
      env,
      async () => resp,
      rt,
    );
    expect(plain).toBe(resp);
  });
});
