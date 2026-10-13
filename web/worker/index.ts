/**
 * The Bazaar edge Worker (deploy/cloudflare.md). Cloudflare serves the SPA from static assets; this Worker runs only
 * for `/api/*` and `/voice` (wrangler.toml `run_worker_first`) and forwards them to the VPS through the Cloudflare
 * Tunnel, so the browser sees one origin: cookies stay SameSite=Strict, the CSP and the WebAuthn RP ID are unchanged,
 * and the server's /voice Origin check still sees https://bazaar.sciscribesolutions.com.
 *
 *   - Not the production host (branch previews, *.workers.dev): 404 JSON, nothing leaves the edge. Previews are visual
 *     only; the app runs on sample data there.
 *   - Production: same method, path, query, body and client headers (Cookie, Origin, Content-Type, X-Bazaar,
 *     Authorization, Upgrade, Sec-WebSocket-*) to ORIGIN_URL, plus X-Bazaar-Edge (the shared secret the VPS checks),
 *     X-Forwarded-Host, X-Forwarded-Proto and X-Real-IP. A client-supplied X-Bazaar-Edge / X-Real-IP / X-Forwarded-* is
 *     dropped first. The response, Set-Cookie included, goes back untouched.
 *   - Never logs cookies, headers or the secret.
 *
 * WebSocket: by default the origin's 101 response is returned as is. If the runtime does not accept that, set the
 * variable WS_MODE=splice and the Worker pairs the sockets itself, piping messages and close codes both ways.
 */

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  PRODUCTION_HOST: string;
  ORIGIN_URL: string;
  /** Secret. Must equal EDGE_SECRET in /opt/bazaar/.env on the VPS. */
  EDGE_SECRET: string;
  /** "passthrough" (default) or "splice". */
  WS_MODE?: string;
}

type FetchImpl = (request: Request) => Promise<Response>;

/** The slice of the Workers WebSocket API the splice needs (and tests fake). */
export interface EdgeSocket {
  accept(): void;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (ev: { data: string | ArrayBuffer }) => void): void;
  addEventListener(type: 'close', fn: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: 'error', fn: () => void): void;
}

export interface Runtime {
  newPair(): { client: EdgeSocket; server: EdgeSocket };
  /** A 101 response that hands `client` to the browser. */
  switching(client: EdgeSocket): Response;
}

declare const WebSocketPair: new () => { 0: EdgeSocket; 1: EdgeSocket };

const workersRuntime: Runtime = {
  newPair() {
    const pair = new WebSocketPair();
    return { client: pair[0], server: pair[1] };
  },
  switching(client) {
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  },
};

export function isForwarded(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/voice';
}

const json = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** Headers the Worker owns: whatever the client sent under these names is discarded. */
const OWNED = [
  'host',
  'x-bazaar-edge',
  'x-real-ip',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-for',
  'forwarded',
];

export function originHeaders(request: Request, env: Pick<Env, 'EDGE_SECRET'>, url: URL): Headers {
  const headers = new Headers(request.headers);
  for (const name of OWNED) headers.delete(name);
  headers.set('x-bazaar-edge', env.EDGE_SECRET);
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', 'https');
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('x-real-ip', ip);
  return headers;
}

/** Close codes that may be sent on the wire; anything else (1005, 1006, ...) becomes a normal close. */
function wireCode(code: number): number {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
    ? code
    : 1000;
}

/** Pair a browser socket with the origin's socket and pipe messages and close codes both ways. */
export function splice(upstream: EdgeSocket, rt: Runtime): Response {
  const { client, server } = rt.newPair();
  server.accept();
  upstream.accept();
  server.addEventListener('message', (ev) => upstream.send(ev.data));
  upstream.addEventListener('message', (ev) => server.send(ev.data));
  server.addEventListener('close', (ev) => upstream.close(wireCode(ev.code), ev.reason));
  upstream.addEventListener('close', (ev) => server.close(wireCode(ev.code), ev.reason));
  server.addEventListener('error', () => upstream.close(1011, 'client error'));
  upstream.addEventListener('error', () => server.close(1011, 'origin error'));
  return rt.switching(client);
}

export async function handle(
  request: Request,
  env: Env,
  fetchImpl: FetchImpl = fetch,
  rt: Runtime = workersRuntime,
): Promise<Response> {
  const url = new URL(request.url);
  if (!isForwarded(url.pathname)) return env.ASSETS.fetch(request);

  if (url.hostname !== env.PRODUCTION_HOST) return json(404, 'preview', 'Previews have no API');

  const target = new URL(url.pathname + url.search, env.ORIGIN_URL);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: originHeaders(request, env, url),
    redirect: 'manual',
  };
  if (hasBody && request.body) {
    init.body = request.body;
    init.duplex = 'half';
  }

  let resp: Response;
  try {
    resp = await fetchImpl(new Request(target, init));
  } catch {
    return json(502, 'origin_unreachable', 'Bazaar is not reachable right now.');
  }

  const upstream = (resp as Response & { webSocket?: EdgeSocket | null }).webSocket;
  if (resp.status === 101 && upstream && env.WS_MODE === 'splice') return splice(upstream, rt);
  return resp;
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env),
};
