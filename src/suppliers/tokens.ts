/**
 * Supplier credential storage. The stored value is an opaque JSON record (OAuth tokens, registered client,
 * PKCE verifier, cached discovery); this module never interprets it. Swap FileTokenStore for a Postgres-backed
 * implementation of the same interface later.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SupplierError } from '../core/errors.js';
import type { SupplierId } from '../core/types.js';

export type StoredAuth = Record<string, unknown>;

export interface TokenStore {
  get(supplierId: SupplierId): Promise<StoredAuth | undefined>;
  set(supplierId: SupplierId, value: StoredAuth): Promise<void>;
  delete(supplierId: SupplierId): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private readonly map = new Map<SupplierId, StoredAuth>();
  async get(supplierId: SupplierId): Promise<StoredAuth | undefined> {
    const v = this.map.get(supplierId);
    return v === undefined ? undefined : structuredClone(v);
  }
  async set(supplierId: SupplierId, value: StoredAuth): Promise<void> {
    this.map.set(supplierId, structuredClone(value));
  }
  async delete(supplierId: SupplierId): Promise<void> {
    this.map.delete(supplierId);
  }
}

interface Envelope {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

/** TOKEN_ENC_KEY must be 32 bytes, base64 encoded. */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error('TOKEN_ENC_KEY is not set (32 bytes, base64)');
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) throw new Error(`TOKEN_ENC_KEY must decode to 32 bytes, got ${key.length}`);
  return key;
}

export class FileTokenStore implements TokenStore {
  private readonly key: Buffer;
  constructor(
    private readonly dir: string = path.resolve('data', 'tokens'),
    key: Buffer | string | undefined = process.env.TOKEN_ENC_KEY,
  ) {
    this.key = Buffer.isBuffer(key) ? key : parseEncryptionKey(key);
    if (this.key.length !== 32) throw new Error('token encryption key must be 32 bytes');
  }

  private file(supplierId: SupplierId): string {
    if (!/^[a-z_]+$/.test(supplierId)) throw new Error(`bad supplier id ${supplierId}`);
    return path.join(this.dir, `${supplierId}.json`);
  }

  async get(supplierId: SupplierId): Promise<StoredAuth | undefined> {
    let text: string;
    try {
      text = await readFile(this.file(supplierId), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    try {
      const env = JSON.parse(text) as Envelope;
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(env.iv, 'base64'));
      decipher.setAAD(Buffer.from(supplierId));
      decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as StoredAuth;
    } catch (e) {
      throw new SupplierError(
        supplierId,
        'tokens',
        'stored token file could not be decrypted (wrong TOKEN_ENC_KEY or corrupt file)',
        { cause: e },
      );
    }
  }

  async set(supplierId: SupplierId, value: StoredAuth): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(supplierId)); // binds the ciphertext to its file
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const env: Envelope = {
      v: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(supplierId);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(env), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  }

  async delete(supplierId: SupplierId): Promise<void> {
    await rm(this.file(supplierId), { force: true });
  }
}
