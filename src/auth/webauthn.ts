/**
 * Passkeys (WebAuthn) — the thin boundary over @simplewebauthn/server. Everything WebAuthn-specific is here:
 * routes call these four methods and never touch the library.
 *
 *   registrationOptions / verifyRegistration   one-time setup link (`/setup/<code>`): resident key + user
 *                                               verification required (Face ID), attestation none.
 *   authenticationOptions / verifyAuthentication   discoverable-credential sign-in (no username; allowCredentials
 *                                               empty) and the "fresh assertion" required to set a PIN.
 *
 * Challenges are random, single use, live 5 minutes and are kept in process memory (one PM2 fork). Each is bound
 * to its purpose (and, for registration, to the setup code that asked for it), and is consumed by the verify call
 * whatever its outcome, so a challenge can never be replayed.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { ISODateTime } from '../core/types.js';
import type { IdentityStore, PasskeyRecord } from './types.js';

export const CHALLENGE_TTL_MS = 5 * 60_000;

export interface WebAuthnConfig {
  /** WEBAUTHN_RP_ID, e.g. bazaar.sciscribesolutions.com (local: localhost). */
  rpId: string;
  /** WEB_ORIGIN, e.g. https://bazaar.sciscribesolutions.com (local: http://localhost:8787). */
  origin: string;
  rpName?: string;
}

/** A passkey operation that failed. `status` is what the route should answer. */
export class PasskeyError extends Error {
  constructor(
    readonly status: 400 | 401 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Purpose = { kind: 'register'; setupId: string; memberId: string } | { kind: 'login' };

/** In-memory single-use challenges. */
export class ChallengeStore {
  private readonly items = new Map<string, { purpose: Purpose; expiresAtMs: number }>();

  constructor(private readonly nowMs: () => number = Date.now) {}

  put(challenge: string, purpose: Purpose): void {
    this.sweep();
    this.items.set(challenge, { purpose, expiresAtMs: this.nowMs() + CHALLENGE_TTL_MS });
  }

  /** Remove and return the challenge's purpose if it is live. */
  take(challenge: string): Purpose | undefined {
    const it = this.items.get(challenge);
    if (!it) return undefined;
    this.items.delete(challenge);
    return it.expiresAtMs > this.nowMs() ? it.purpose : undefined;
  }

  private sweep(): void {
    const now = this.nowMs();
    for (const [k, v] of this.items) if (v.expiresAtMs <= now) this.items.delete(k);
  }

  get size(): number {
    return this.items.size;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The challenge the client signed, read from clientDataJSON (base64url JSON). */
function clientChallenge(response: { response: { clientDataJSON: string } }): string | undefined {
  try {
    const cd = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as unknown;
    return isObj(cd) && typeof cd.challenge === 'string' ? cd.challenge : undefined;
  } catch {
    return undefined;
  }
}

function shape(raw: unknown, fields: string[]): boolean {
  if (!isObj(raw) || typeof raw.id !== 'string' || typeof raw.rawId !== 'string' || !isObj(raw.response)) return false;
  const r = raw.response;
  return fields.every((f) => typeof r[f] === 'string');
}

export class PasskeyAuth {
  readonly challenges: ChallengeStore;

  constructor(
    private readonly store: IdentityStore,
    private readonly cfg: WebAuthnConfig,
    private readonly now: () => ISODateTime = () => new Date().toISOString(),
    challenges?: ChallengeStore,
  ) {
    this.challenges = challenges ?? new ChallengeStore(() => Date.parse(this.now()));
  }

  async registrationOptions(member: { id: string; name: string }, setupId: string) {
    const existing = await this.store.listPasskeys(member.id);
    const options = await generateRegistrationOptions({
      rpName: this.cfg.rpName ?? 'Bazaar',
      rpID: this.cfg.rpId,
      userName: member.name,
      userDisplayName: member.name,
      userID: new TextEncoder().encode(member.id),
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({
        id: p.id,
        transports: p.transports as NonNullable<RegistrationResponseJSON['response']['transports']>,
      })),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    });
    this.challenges.put(options.challenge, { kind: 'register', setupId, memberId: member.id });
    return options;
  }

  /**
   * Verify a registration made with options from `registrationOptions(member, setupId)`. Returns the passkey to
   * store; the caller saves it once it has consumed the setup code (single use).
   */
  async verifyRegistration(member: { id: string }, setupId: string, raw: unknown): Promise<PasskeyRecord> {
    if (!shape(raw, ['clientDataJSON', 'attestationObject']))
      throw new PasskeyError(400, 'bad_registration', 'registration response is malformed');
    const response = raw as unknown as RegistrationResponseJSON;
    const challenge = clientChallenge(response);
    const purpose = challenge ? this.challenges.take(challenge) : undefined;
    if (!purpose || purpose.kind !== 'register' || purpose.setupId !== setupId || purpose.memberId !== member.id)
      throw new PasskeyError(400, 'challenge_expired', 'the setup request expired; start again');
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge!,
        expectedOrigin: this.cfg.origin,
        expectedRPID: this.cfg.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw new PasskeyError(400, 'registration_failed', 'the passkey could not be verified');
    }
    if (!verification.verified) throw new PasskeyError(400, 'registration_failed', 'the passkey could not be verified');
    const info = verification.registrationInfo;
    if (await this.store.findPasskey(info.credential.id))
      throw new PasskeyError(409, 'passkey_exists', 'this passkey is already registered');
    const passkey: PasskeyRecord = {
      id: info.credential.id,
      memberId: member.id,
      publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
      counter: info.credential.counter,
      transports: info.credential.transports ?? response.response.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      createdAt: this.now(),
    };
    return passkey;
  }

  /** Options for a discoverable-credential assertion (sign-in, or the fresh assertion before setting a PIN). */
  async authenticationOptions() {
    const options = await generateAuthenticationOptions({
      rpID: this.cfg.rpId,
      userVerification: 'required',
      allowCredentials: [],
    });
    this.challenges.put(options.challenge, { kind: 'login' });
    return options;
  }

  /** Verify an assertion against a challenge from `authenticationOptions()`; returns whose passkey signed it. */
  async verifyAuthentication(raw: unknown): Promise<{ memberId: string; credentialId: string }> {
    if (!shape(raw, ['clientDataJSON', 'authenticatorData', 'signature']))
      throw new PasskeyError(400, 'bad_assertion', 'assertion is malformed');
    const response = raw as unknown as AuthenticationResponseJSON;
    const challenge = clientChallenge(response);
    const purpose = challenge ? this.challenges.take(challenge) : undefined;
    if (!purpose || purpose.kind !== 'login')
      throw new PasskeyError(401, 'challenge_expired', 'the sign-in request expired; try again');
    const passkey = await this.store.findPasskey(response.id);
    if (!passkey) throw new PasskeyError(401, 'unknown_passkey', 'this passkey is not registered');
    const userHandle = response.response.userHandle;
    if (userHandle && Buffer.from(userHandle, 'base64url').toString('utf8') !== passkey.memberId)
      throw new PasskeyError(401, 'unknown_passkey', 'this passkey is not registered');
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge!,
        expectedOrigin: this.cfg.origin,
        expectedRPID: this.cfg.rpId,
        requireUserVerification: true,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
          counter: passkey.counter,
          transports: passkey.transports as NonNullable<RegistrationResponseJSON['response']['transports']>,
        },
      });
    } catch {
      throw new PasskeyError(401, 'assertion_failed', 'the passkey could not be verified');
    }
    if (!verification.verified) throw new PasskeyError(401, 'assertion_failed', 'the passkey could not be verified');
    await this.store.updatePasskeyCounter(passkey.id, verification.authenticationInfo.newCounter, this.now());
    return { memberId: passkey.memberId, credentialId: passkey.id };
  }
}
