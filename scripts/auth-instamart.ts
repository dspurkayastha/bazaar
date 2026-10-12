/**
 * pnpm auth:instamart
 *
 * Headless-friendly OAuth login for Swiggy Instamart. Prints the authorization URL, waits on
 * http://127.0.0.1:8765/callback, saves the (encrypted) token, then lists your saved addresses.
 * On a server with no browser, forward the port from your laptop first:  ssh -L 8765:127.0.0.1:8765 <vps>
 */
import 'dotenv/config';
import http from 'node:http';
import {
  InstamartMcpClient,
  beginAuthorization,
  finishAuthorization,
  DEFAULT_REDIRECT_URL,
} from '../src/suppliers/instamart/mcp.js';
import { FileTokenStore } from '../src/suppliers/tokens.js';

const HOST = '127.0.0.1';
const PORT = 8765;
const TIMEOUT_MS = 10 * 60_000;

function waitForCallback(server: http.Server): Promise<{ code: string; state: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for the browser callback (10 min)')),
      TIMEOUT_MS,
    );
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      res.writeHead(error || !code ? 400 : 200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        error || !code
          ? `Login failed: ${error ?? 'no code returned'}`
          : 'Instamart login complete. You can close this tab.',
      );
      clearTimeout(timer);
      if (error || !code) reject(new Error(`authorization failed: ${error ?? 'no code in callback'}`));
      else resolve({ code, state: url.searchParams.get('state') });
    });
  });
}

async function main(): Promise<void> {
  const store = new FileTokenStore();
  const client = new InstamartMcpClient({ store, redirectUrl: DEFAULT_REDIRECT_URL });
  const provider = client.provider;

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });

  try {
    const pending = waitForCallback(server);
    pending.catch(() => undefined); // surfaced below; avoid unhandled rejection if we skip waiting

    // Hook the provider so the SDK prints the URL instead of opening a browser.
    let printed = false;
    provider.redirectToAuthorization = async (url: URL) => {
      printed = true;
      console.log('\nOpen this URL in a browser, sign in to Swiggy, and approve access:\n');
      console.log(`  ${url.toString()}\n`);
      console.log(`Waiting for the redirect on ${DEFAULT_REDIRECT_URL} ...`);
      console.log(
        `(Headless server? From your laptop run: ssh -L ${PORT}:${HOST}:${PORT} <your-vps>  and open the URL locally.)`,
      );
    };

    const result = await beginAuthorization(provider);
    if (result === 'REDIRECT' && printed) {
      const { code, state } = await pending;
      const expected = await provider.savedState();
      if (expected && state !== expected)
        throw new Error('OAuth state mismatch; aborting (possible CSRF). Re-run the command.');
      await finishAuthorization(provider, code);
      console.log('Token saved (encrypted) to data/tokens/instamart.json');
    } else {
      console.log('Existing token is still valid (or was refreshed); nothing to authorize.');
    }

    console.log('\nVerifying with get_addresses ...');
    const out = (await client.callTool('get_addresses', { pageSize: 10 })) as {
      addresses?: { id: string; addressLine?: string; addressCategory?: string; addressTag?: string }[];
      total?: number;
    };
    const list = out.addresses ?? [];
    console.log(`Saved addresses (${out.total ?? list.length}):`);
    for (const a of list) {
      console.log(
        `  ${a.id}\n    ${[a.addressTag, a.addressCategory].filter(Boolean).join(' / ')}  ${a.addressLine ?? ''}`,
      );
    }
    if (list.length === 0) console.log('  (none returned; add one in the Swiggy app first)');
  } finally {
    server.close();
    await client.close().catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\nauth:instamart failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
