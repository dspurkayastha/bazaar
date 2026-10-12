/**
 * A software passkey authenticator for tests: real P-256 keys, real CBOR attestation objects ("none" format), real
 * ES256 assertion signatures, so the WebAuthn boundary (src/auth/webauthn.ts) is exercised against the actual
 * @simplewebauthn/server verification with no mocks and no network.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';

// ---------- minimal CBOR encoder (major types 0, 1, 2, 3, 5) ----------

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, x] of v) parts.push(cbor(k), cbor(x));
  return Buffer.concat(parts);
}

const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

export interface SoftPasskey {
  credentialId: Buffer;
  privateKey: KeyObject;
  cose: Buffer;
  userHandle: string;
  counter: number;
}

export class SoftAuthenticator {
  readonly passkeys: SoftPasskey[] = [];

  constructor(
    readonly rpId: string,
    readonly origin: string,
    /** Set false to simulate an authenticator that skips user verification. */
    public userVerified = true,
  ) {}

  private flags(extra: number): number {
    return 0x01 | (this.userVerified ? 0x04 : 0) | extra;
  }

  /** navigator.credentials.create() → RegistrationResponseJSON for the given options. */
  register(options: { challenge: string; user: { id: string } }, opts: { origin?: string } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const credentialId = randomBytes(16);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([this.flags(0x40)]),
      Buffer.alloc(4), // counter 0, like Apple passkeys
      Buffer.alloc(16), // aaguid
      idLen,
      credentialId,
      cose,
    ]);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: opts.origin ?? this.origin }),
    );
    // options.user.id is base64url of the user handle bytes
    const userHandle = Buffer.from(options.user.id, 'base64url').toString('utf8');
    this.passkeys.push({ credentialId, privateKey, cose, userHandle, counter: 0 });
    return {
      id: b64u(credentialId),
      rawId: b64u(credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get() with a discoverable credential → AuthenticationResponseJSON. */
  assert(
    options: { challenge: string },
    opts: { passkey?: SoftPasskey; origin?: string; counter?: number; userHandle?: string } = {},
  ) {
    const pk = opts.passkey ?? this.passkeys[0];
    if (!pk) throw new Error('no passkey registered');
    const counter = opts.counter ?? pk.counter;
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    const authenticatorData = Buffer.concat([sha256(this.rpId), Buffer.from([this.flags(0)]), c]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: opts.origin ?? this.origin }),
    );
    const signature = createSign('sha256')
      .update(Buffer.concat([authenticatorData, sha256(clientDataJSON)]))
      .sign(pk.privateKey); // DER, as WebAuthn ES256 expects
    return {
      id: b64u(pk.credentialId),
      rawId: b64u(pk.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authenticatorData),
        signature: b64u(signature),
        userHandle: b64u(Buffer.from(opts.userHandle ?? pk.userHandle, 'utf8')),
      },
      clientExtensionResults: {},
    };
  }
}
