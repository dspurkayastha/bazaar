import { describe, expect, it } from 'vitest';
import { SupplierError } from '../src/core/errors.js';
import { InstamartSupplier } from '../src/suppliers/instamart/adapter.js';
import {
  DEFAULT_REDIRECT_URL,
  NON_REPLAYABLE_TOOLS,
  StoreBackedOAuthProvider,
  parseToolResult,
  toolResultToJson,
} from '../src/suppliers/instamart/mcp.js';
import { getSupplier, resetSuppliers, setSupplier } from '../src/suppliers/registry.js';
import { StubSupplier } from '../src/suppliers/stub/index.js';
import { MemoryTokenStore } from '../src/suppliers/tokens.js';
import { fixture } from './fixtures/instamart/harness.js';

describe('tool result parsing', () => {
  it('prefers structuredContent, then JSON text, then raw text', () => {
    expect(parseToolResult({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"a":2}' }] })).toEqual({
      a: 1,
    });
    expect(parseToolResult({ content: [{ type: 'text', text: '{"products":[]}' }] })).toEqual({ products: [] });
    expect(parseToolResult({ content: [{ type: 'text', text: 'SUCCESS' }] })).toBe('SUCCESS');
    expect(parseToolResult({ content: [] })).toBeNull();
  });

  it('throws SupplierError with the tool name and the server message on isError', () => {
    const err = (() => {
      try {
        toolResultToJson('update_cart', fixture('error_generic'));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(SupplierError);
    expect((err as SupplierError).operation).toBe('update_cart');
    expect((err as SupplierError).message).toBe(
      'instamart.update_cart: Item SPIN-0001 is out of stock at your location.',
    );
  });

  it('never replays money-moving tools', () => {
    expect(NON_REPLAYABLE_TOOLS.has('checkout')).toBe(true);
    expect(NON_REPLAYABLE_TOOLS.has('confirm_order')).toBe(true);
    expect(NON_REPLAYABLE_TOOLS.has('get_cart')).toBe(false);
  });
});

describe('store-backed OAuth provider', () => {
  it('describes a public PKCE client on the local callback', () => {
    const p = new StoreBackedOAuthProvider({ store: new MemoryTokenStore() });
    expect(p.redirectUrl).toBe(DEFAULT_REDIRECT_URL);
    expect(DEFAULT_REDIRECT_URL).toBe('http://127.0.0.1:8765/callback');
    expect(p.clientMetadata).toMatchObject({
      redirect_uris: [DEFAULT_REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('persists client, verifier, state, tokens and discovery through the TokenStore', async () => {
    const store = new MemoryTokenStore();
    const p = new StoreBackedOAuthProvider({ store });
    await p.saveClientInformation({ client_id: 'cid' });
    await p.saveCodeVerifier('verifier-1');
    const state = await p.state();
    expect(await p.savedState()).toBe(state);
    expect(await p.codeVerifier()).toBe('verifier-1');
    await p.saveTokens({ access_token: 'a1', refresh_token: 'r1', token_type: 'Bearer', expires_in: 3600 });

    const q = new StoreBackedOAuthProvider({ store }); // a fresh process
    expect(await q.clientInformation()).toMatchObject({ client_id: 'cid' });
    expect((await q.tokens())?.access_token).toBe('a1');
    await expect(q.codeVerifier()).rejects.toBeInstanceOf(SupplierError); // verifier is cleared after use
    expect(await q.savedState()).toBeUndefined();
  });

  it('keeps the old refresh token when a refresh response omits it', async () => {
    const store = new MemoryTokenStore();
    const p = new StoreBackedOAuthProvider({ store });
    await p.saveTokens({ access_token: 'a1', refresh_token: 'r1', token_type: 'Bearer' });
    await p.saveTokens({ access_token: 'a2', token_type: 'Bearer' });
    const t = await p.tokens();
    expect(t?.access_token).toBe('a2');
    expect(t?.refresh_token).toBe('r1');
  });

  it('without an onRedirect hook it tells the operator to run the auth script instead of hanging', async () => {
    const p = new StoreBackedOAuthProvider({ store: new MemoryTokenStore() });
    await expect(p.redirectToAuthorization(new URL('https://example.invalid/authorize'))).rejects.toThrow(
      /pnpm auth:instamart/,
    );
  });

  it('invalidates credentials by scope', async () => {
    const store = new MemoryTokenStore();
    const p = new StoreBackedOAuthProvider({ store });
    await p.saveClientInformation({ client_id: 'cid' });
    await p.saveTokens({ access_token: 'a1', token_type: 'Bearer' });
    await p.invalidateCredentials('tokens');
    expect(await p.tokens()).toBeUndefined();
    expect(await p.clientInformation()).toBeDefined();
    await p.invalidateCredentials('all');
    expect(await store.get('instamart')).toBeUndefined();
  });
});

describe('supplier registry', () => {
  it('returns the stub for "stub"', () => {
    resetSuppliers();
    expect(getSupplier('stub')).toBeInstanceOf(StubSupplier);
    expect(getSupplier('stub')).toBe(getSupplier('stub'));
  });

  it('only builds instamart when configured', () => {
    resetSuppliers();
    expect(() => getSupplier('instamart', { env: {} })).toThrow(/not configured/);
    expect(getSupplier('instamart', { tokenStore: new MemoryTokenStore() })).toBeInstanceOf(InstamartSupplier);
    resetSuppliers();
  });

  it('refuses suppliers without an adapter and allows test injection', () => {
    resetSuppliers();
    expect(() => getSupplier('zepto')).toThrow(SupplierError);
    const fake = new StubSupplier({ id: 'zepto' });
    setSupplier('zepto', fake);
    expect(getSupplier('zepto')).toBe(fake);
    resetSuppliers();
  });
});
