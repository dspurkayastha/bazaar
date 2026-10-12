/**
 * MCP client for Swiggy Instamart (https://mcp.swiggy.com/im) over Streamable HTTP, with OAuth 2.0 + PKCE.
 *
 * Discovery (RFC 9728 protected-resource metadata -> RFC 8414 authorization-server metadata), dynamic client
 * registration, PKCE and refresh are all done by the SDK's `auth()` flow; this file only supplies an
 * OAuthClientProvider that persists everything through a TokenStore.
 *
 * Safety (docs/instamart-tools.json notes):
 *  - checkout and confirm_order are NEVER retried or re-sent by this layer, including after a transport error
 *    or a re-auth. The caller must check get_orders first (double-charge risk).
 *  - confirmDuplicate is never injected here; only the adapter may pass it, and only when the server asked.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { randomBytes } from 'node:crypto';
import { SupplierError } from '../../core/errors.js';
import type { TokenStore } from '../tokens.js';

export const INSTAMART_MCP_URL = 'https://mcp.swiggy.com/im';
export const DEFAULT_REDIRECT_URL = 'http://127.0.0.1:8765/callback';
const SUPPLIER = 'instamart' as const;

/** The only seam the adapter depends on; tests inject a fake. */
export type CallTool = (name: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Tools that move money or order state. Never auto-retried, never replayed after reconnect. */
export const NON_REPLAYABLE_TOOLS = new Set(['checkout', 'confirm_order']);

export interface StoreBackedProviderOptions {
  store: TokenStore;
  redirectUrl?: string;
  /** Called with the authorization URL. Interactive scripts print it; headless services leave this unset. */
  onRedirect?: (url: URL) => void | Promise<void>;
}

/** OAuthClientProvider that keeps tokens, registered client, PKCE verifier, state and discovery in a TokenStore. */
export class StoreBackedOAuthProvider implements OAuthClientProvider {
  private readonly redirect: string;
  constructor(private readonly opts: StoreBackedProviderOptions) {
    this.redirect = opts.redirectUrl ?? DEFAULT_REDIRECT_URL;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Bazaar',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  private async read(): Promise<Record<string, unknown>> {
    return (await this.opts.store.get(SUPPLIER)) ?? {};
  }
  private async patch(p: Record<string, unknown>): Promise<void> {
    // Read-modify-write; the auth flow is sequential so there is no concurrent writer to race.
    await this.opts.store.set(SUPPLIER, { ...(await this.read()), ...p });
  }

  async state(): Promise<string> {
    const s = randomBytes(24).toString('base64url');
    await this.patch({ oauthState: s });
    return s;
  }
  async savedState(): Promise<string | undefined> {
    return (await this.read()).oauthState as string | undefined;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.read()).clientInformation as OAuthClientInformationMixed | undefined;
  }
  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.patch({ clientInformation: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.read()).tokens as OAuthTokens | undefined;
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // A refresh response may omit refresh_token; keep the old one so refresh keeps working.
    const prev = (await this.tokens()) as (OAuthTokens & { refresh_token?: string }) | undefined;
    const merged = { ...tokens } as OAuthTokens & { refresh_token?: string; obtained_at?: number };
    if (!merged.refresh_token && prev?.refresh_token) merged.refresh_token = prev.refresh_token;
    merged.obtained_at = Date.now();
    await this.patch({ tokens: merged, codeVerifier: undefined, oauthState: undefined });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.opts.onRedirect) {
      throw new SupplierError(SUPPLIER, 'auth', 'Instamart login is missing or expired. Run: pnpm auth:instamart');
    }
    await this.opts.onRedirect(url);
  }

  async saveCodeVerifier(v: string): Promise<void> {
    await this.patch({ codeVerifier: v });
  }
  async codeVerifier(): Promise<string> {
    const v = (await this.read()).codeVerifier as string | undefined;
    if (!v) throw new SupplierError(SUPPLIER, 'auth', 'no PKCE verifier saved; restart pnpm auth:instamart');
    return v;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.patch({ discoveryState: state });
  }
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.read()).discoveryState as OAuthDiscoveryState | undefined;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') return this.opts.store.delete(SUPPLIER);
    const key = {
      client: 'clientInformation',
      tokens: 'tokens',
      verifier: 'codeVerifier',
      discovery: 'discoveryState',
    }[scope];
    await this.patch({ [key]: undefined });
  }
}

export interface InstamartMcpOptions {
  store: TokenStore;
  url?: string;
  redirectUrl?: string;
  /** Per-call timeout in ms (default 30s; checkout 90s). */
  timeoutMs?: number;
}

/** Pull the text of an MCP tool result (all text parts joined). */
function resultText(result: { content?: unknown }): string {
  const parts = Array.isArray(result.content) ? result.content : [];
  return parts
    .map((p) =>
      p && typeof p === 'object' && (p as { type?: string }).type === 'text'
        ? String((p as { text?: unknown }).text ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

/** Parse a tool result into JSON. Prefers structuredContent; falls back to JSON text; else the raw string. */
export function parseToolResult(result: { content?: unknown; structuredContent?: unknown }): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  const text = resultText(result).trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Turn a raw MCP tool result into parsed JSON, or throw SupplierError(tool, server message) when isError. */
export function toolResultToJson(
  name: string,
  result: { content?: unknown; structuredContent?: unknown; isError?: boolean },
): unknown {
  if (result.isError) {
    const msg = resultText(result) || 'tool returned an error with no message';
    throw new SupplierError(SUPPLIER, name, msg);
  }
  return parseToolResult(result);
}

export class InstamartMcpClient {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  readonly provider: StoreBackedOAuthProvider;
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(opts: InstamartMcpOptions) {
    this.url = opts.url ?? INSTAMART_MCP_URL;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.provider = new StoreBackedOAuthProvider({
      store: opts.store,
      ...(opts.redirectUrl !== undefined ? { redirectUrl: opts.redirectUrl } : {}),
    });
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const client = new Client({ name: 'bazaar', version: '0.1.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(this.url), { authProvider: this.provider });
      try {
        await client.connect(transport);
      } catch (e) {
        if (e instanceof UnauthorizedError) {
          throw new SupplierError(SUPPLIER, 'auth', 'Instamart login is missing or expired. Run: pnpm auth:instamart', {
            cause: e,
          });
        }
        throw new SupplierError(SUPPLIER, 'connect', e instanceof Error ? e.message : String(e), { cause: e });
      }
      client.onclose = () => {
        if (this.client === client) this.client = undefined;
      };
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    await c?.close();
  }

  /** callTool(name, args) -> parsed JSON content. Throws SupplierError carrying the tool name and server message. */
  readonly callTool: CallTool = async (name, args = {}) => {
    const replayable = !NON_REPLAYABLE_TOOLS.has(name);
    for (let attempt = 0; ; attempt++) {
      let client: Client;
      try {
        client = await this.connect();
      } catch (e) {
        if (e instanceof SupplierError)
          throw new SupplierError(SUPPLIER, name, e.message.replace(/^instamart\.\w+: /, ''), { cause: e });
        throw e;
      }
      try {
        const timeout = name === 'checkout' ? Math.max(this.timeoutMs, 90_000) : this.timeoutMs;
        const result = (await client.callTool({ name, arguments: args }, undefined, { timeout })) as {
          content?: unknown;
          structuredContent?: unknown;
          isError?: boolean;
        };
        return toolResultToJson(name, result);
      } catch (e) {
        if (e instanceof SupplierError) throw e;
        // Session dropped / token expired mid-call: reconnect once, but only for idempotent reads and cart writes.
        const dropped = e instanceof UnauthorizedError || (e instanceof Error && /session|closed|401/i.test(e.message));
        if (dropped && replayable && attempt === 0) {
          await this.close().catch(() => undefined);
          continue;
        }
        const detail = e instanceof Error ? e.message : String(e);
        const hint = replayable ? '' : ' (outcome unknown: check get_orders before any retry)';
        throw new SupplierError(SUPPLIER, name, `${detail}${hint}`, { cause: e });
      }
    }
  };
}

/** Run the SDK auth flow once. Returns the authorization URL when user interaction is needed. */
export async function beginAuthorization(
  provider: StoreBackedOAuthProvider,
  serverUrl: string = INSTAMART_MCP_URL,
): Promise<'AUTHORIZED' | 'REDIRECT'> {
  return auth(provider, { serverUrl });
}

/** Exchange the callback code for tokens. */
export async function finishAuthorization(
  provider: StoreBackedOAuthProvider,
  code: string,
  serverUrl: string = INSTAMART_MCP_URL,
): Promise<void> {
  const r = await auth(provider, { serverUrl, authorizationCode: code });
  if (r !== 'AUTHORIZED') throw new SupplierError(SUPPLIER, 'auth', 'token exchange did not complete');
}
