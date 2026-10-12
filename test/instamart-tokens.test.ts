import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTokenStore, MemoryTokenStore, parseEncryptionKey } from '../src/suppliers/tokens.js';

const dirs: string[] = [];
async function tmp() {
  const d = await mkdtemp(path.join(tmpdir(), 'bazaar-tok-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const value = { tokens: { access_token: 'secret-access-123', refresh_token: 'secret-refresh-456' }, n: 1 };

describe('token stores', () => {
  it('memory store round-trips and isolates copies', async () => {
    const s = new MemoryTokenStore();
    expect(await s.get('instamart')).toBeUndefined();
    await s.set('instamart', value);
    const got = await s.get('instamart');
    expect(got).toEqual(value);
    (got as { n: number }).n = 9;
    expect((await s.get('instamart'))?.n).toBe(1);
    await s.delete('instamart');
    expect(await s.get('instamart')).toBeUndefined();
  });

  it('file store round-trips, encrypts at rest, and rejects a wrong key', async () => {
    const dir = await tmp();
    const key = randomBytes(32);
    const s = new FileTokenStore(dir, key);
    await s.set('instamart', value);
    const onDisk = await readFile(path.join(dir, 'instamart.json'), 'utf8');
    expect(onDisk).not.toContain('secret-access-123');
    expect(onDisk).not.toContain('secret-refresh-456');
    expect(await s.get('instamart')).toEqual(value);
    expect(await new FileTokenStore(dir, key).get('instamart')).toEqual(value);
    await expect(new FileTokenStore(dir, randomBytes(32)).get('instamart')).rejects.toThrow(/decrypted/);
    await s.delete('instamart');
    expect(await s.get('instamart')).toBeUndefined();
  });

  it('uses a fresh IV per write and validates the key', async () => {
    const dir = await tmp();
    const s = new FileTokenStore(dir, randomBytes(32));
    await s.set('instamart', value);
    const a = await readFile(path.join(dir, 'instamart.json'), 'utf8');
    await s.set('instamart', value);
    const b = await readFile(path.join(dir, 'instamart.json'), 'utf8');
    expect(a).not.toEqual(b);
    expect(() => parseEncryptionKey(undefined)).toThrow(/TOKEN_ENC_KEY/);
    expect(() => parseEncryptionKey(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
  });
});
