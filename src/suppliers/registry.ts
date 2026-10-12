/**
 * Supplier lookup. 'stub' is the in-memory supplier for tests and demos; 'instamart' is the real adapter and
 * exists only when configured (TOKEN_ENC_KEY set, so the stored OAuth token can be decrypted).
 */
import { SupplierError } from '../core/errors.js';
import type { Supplier, SupplierId } from '../core/types.js';
import { InstamartSupplier } from './instamart/adapter.js';
import { InstamartMcpClient } from './instamart/mcp.js';
import { StubSupplier } from './stub/index.js';
import { FileTokenStore } from './tokens.js';
import type { TokenStore } from './tokens.js';

export type RegistryId = SupplierId | 'stub';

const cache = new Map<RegistryId, Supplier>();

export function isInstamartConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TOKEN_ENC_KEY && env.TOKEN_ENC_KEY.trim() !== '');
}

export interface RegistryOptions {
  env?: NodeJS.ProcessEnv;
  tokenStore?: TokenStore;
}

export function getSupplier(id: RegistryId, opts: RegistryOptions = {}): Supplier {
  const hit = cache.get(id);
  if (hit) return hit;
  const env = opts.env ?? process.env;
  let supplier: Supplier;
  if (id === 'stub') {
    supplier = new StubSupplier();
  } else if (id === 'instamart') {
    if (!opts.tokenStore && !isInstamartConfigured(env)) {
      throw new SupplierError(
        'instamart',
        'registry',
        'Instamart is not configured: set TOKEN_ENC_KEY and run pnpm auth:instamart',
      );
    }
    const store = opts.tokenStore ?? new FileTokenStore(undefined, env.TOKEN_ENC_KEY);
    supplier = new InstamartSupplier({ callTool: new InstamartMcpClient({ store }).callTool });
  } else {
    throw new SupplierError(id, 'registry', `no adapter for supplier ${id}`);
  }
  cache.set(id, supplier);
  return supplier;
}

/** Test hook: inject a supplier or clear the cache. */
export function setSupplier(id: RegistryId, supplier: Supplier | undefined): void {
  if (supplier) cache.set(id, supplier);
  else cache.delete(id);
}

export function resetSuppliers(): void {
  cache.clear();
}
