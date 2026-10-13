/**
 * Sample mode: the app on any host except production and local development shows fixtures and never calls the API.
 * Cloudflare branch previews (and *.workers.dev) are visual only: the Worker answers 404 on /api and /voice there anyway
 * (web/worker/index.ts), and the app does not even ask.
 */
export const PRODUCTION_HOST = 'bazaar.sciscribesolutions.com';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isSampleMode(loc: Pick<Location, 'hostname'> = location): boolean {
  const host = (loc.hostname || '').toLowerCase();
  return host !== PRODUCTION_HOST && !LOCAL_HOSTS.has(host);
}
