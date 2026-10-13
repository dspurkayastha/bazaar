/** web/public/_headers (Cloudflare static assets) must carry the same CSP as the Node server (src/api/static.ts). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMMUTABLE, NO_CACHE, contentSecurityPolicy } from '../src/api/static.js';

const text = readFileSync(new URL('../web/public/_headers', import.meta.url), 'utf8');

/** {pattern -> {header(lowercase) -> value}} */
function parse(src: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let cur: Record<string, string> | undefined;
  for (const raw of src.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      cur = out[raw.trim()] = {};
      continue;
    }
    const i = raw.indexOf(':');
    cur![raw.slice(0, i).trim().toLowerCase()] = raw.slice(i + 1).trim();
  }
  return out;
}

describe('_headers', () => {
  const h = parse(text);

  it('has the server CSP for production, plus nosniff, referrer policy and frame blocking', () => {
    const all = h['/*']!;
    expect(all['content-security-policy']).toBe(contentSecurityPolicy('https://bazaar.sciscribesolutions.com'));
    expect(all['x-content-type-options']).toBe('nosniff');
    expect(all['referrer-policy']).toBe('no-referrer');
    expect(all['x-frame-options']).toBe('DENY');
  });

  it('caches hashed assets forever and the shell not at all', () => {
    expect(h['/assets/*']!['cache-control']).toBe(IMMUTABLE);
    for (const p of ['/', '/index.html', '/sw.js']) expect(h[p]!['cache-control']).toBe(NO_CACHE);
  });

  it('never sets cache-control on the catch-all (it would merge with the specific rules)', () => {
    expect(h['/*']!['cache-control']).toBeUndefined();
  });
});
