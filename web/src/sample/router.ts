import { ApiError } from '../api';
import { sampleCarts, sampleHousehold, sampleLedger, sampleMe, sampleSupplierAddresses } from './fixtures';
import { PREVIEW_ONLY, showToast } from './toast';

/**
 * The whole sample-mode API, switched in at the api layer (src/api.ts) so no screen needs to know. Reads answer from
 * fixtures; every write shows the "Preview only" toast and throws a normal ApiError the screen already knows how to
 * show. Nothing here touches the network.
 */
export async function sampleRequest<T>(method: string, path: string): Promise<T> {
  if (method !== 'GET') {
    showToast(PREVIEW_ONLY);
    throw new ApiError(0, 'preview', PREVIEW_ONLY);
  }
  const url = new URL(path, 'http://sample.invalid');
  switch (url.pathname) {
    case '/api/me':
      return sampleMe() as T;
    case '/api/carts':
      return sampleCarts() as T;
    case '/api/household':
      return sampleHousehold() as T;
    case '/api/household/supplier-addresses':
      return sampleSupplierAddresses() as T;
    case '/api/ledger': {
      const month = url.searchParams.get('month') ?? '';
      return sampleLedger(/^\d{4}-\d{2}$/.test(month) ? month : '2026-10') as T;
    }
    default:
      throw new ApiError(404, 'not_found', 'Not in the preview.');
  }
}
