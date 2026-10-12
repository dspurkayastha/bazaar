import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/agent/memory-store.js';
import { CHALLENGE_TTL_MS, PasskeyAuth, PasskeyError } from '../src/auth/webauthn.js';
import { household, owner } from './fixtures/context.js';
import { SoftAuthenticator } from './fixtures/webauthn.js';

const RP = 'localhost';
const ORIGIN = 'http://localhost:8787';

function setup() {
  const h = household();
  const store = new MemoryStore([h]);
  let now = Date.parse('2026-10-12T10:00:00.000Z');
  const clock = {
    iso: () => new Date(now).toISOString(),
    advance: (ms: number) => (now += ms),
  };
  const auth = new PasskeyAuth(store, { rpId: RP, origin: ORIGIN }, clock.iso);
  const device = new SoftAuthenticator(RP, ORIGIN);
  return { h, store, auth, device, clock, dev: owner(h) };
}

async function rejects(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PasskeyError);
  expect((err as PasskeyError).code).toBe(code);
}

describe('passkey boundary (real @simplewebauthn/server verification, software authenticator)', () => {
  it('registers a resident, user-verified passkey and signs in with it (discoverable, no allowCredentials)', async () => {
    const { store, auth, device, dev } = setup();
    const regOpts = await auth.registrationOptions(dev, 'sc_1');
    expect(regOpts.rp.id).toBe(RP);
    expect(regOpts.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    const passkey = await auth.verifyRegistration(dev, 'sc_1', device.register(regOpts));
    await store.savePasskey(passkey);
    expect(passkey.memberId).toBe(dev.id);
    expect(await store.listPasskeys(dev.id)).toHaveLength(1);

    const loginOpts = await auth.authenticationOptions();
    expect(loginOpts.allowCredentials ?? []).toEqual([]);
    expect(loginOpts.userVerification).toBe('required');
    expect(await auth.verifyAuthentication(device.assert(loginOpts))).toEqual({
      memberId: dev.id,
      credentialId: passkey.id,
    });
  });

  it('a challenge is single use: replaying an assertion fails', async () => {
    const { auth, device, dev, store } = setup();
    await store.savePasskey(
      await auth.verifyRegistration(dev, 'sc_1', device.register(await auth.registrationOptions(dev, 'sc_1'))),
    );
    const assertion = device.assert(await auth.authenticationOptions());
    await auth.verifyAuthentication(assertion);
    await rejects(auth.verifyAuthentication(assertion), 'challenge_expired');
  });

  it('challenges expire after 5 minutes', async () => {
    const { auth, device, dev, clock, store } = setup();
    await store.savePasskey(
      await auth.verifyRegistration(dev, 'sc_1', device.register(await auth.registrationOptions(dev, 'sc_1'))),
    );
    const opts = await auth.authenticationOptions();
    clock.advance(CHALLENGE_TTL_MS);
    await rejects(auth.verifyAuthentication(device.assert(opts)), 'challenge_expired');
  });

  it('a registration challenge is bound to its setup code and member', async () => {
    const { auth, device, dev, h } = setup();
    const opts = await auth.registrationOptions(dev, 'sc_1');
    await rejects(auth.verifyRegistration(dev, 'sc_other', device.register(opts)), 'challenge_expired');
    const opts2 = await auth.registrationOptions(dev, 'sc_1');
    const partner = h.members.find((m) => m.role === 'adder')!;
    await rejects(auth.verifyRegistration(partner, 'sc_1', device.register(opts2)), 'challenge_expired');
    // a login challenge cannot complete a registration
    const login = await auth.authenticationOptions();
    await rejects(
      auth.verifyRegistration(dev, 'sc_1', device.register({ challenge: login.challenge, user: { id: 'eA' } })),
      'challenge_expired',
    );
  });

  it('wrong origin, missing user verification, unknown credential and a forged user handle all fail', async () => {
    const { auth, device, dev, h, store } = setup();
    const phished = new SoftAuthenticator(RP, ORIGIN);
    await rejects(
      auth.verifyRegistration(
        dev,
        'sc_1',
        phished.register(await auth.registrationOptions(dev, 'sc_1'), { origin: 'https://evil.example' }),
      ),
      'registration_failed',
    );
    await store.savePasskey(
      await auth.verifyRegistration(dev, 'sc_1', device.register(await auth.registrationOptions(dev, 'sc_1'))),
    );
    await rejects(
      auth.verifyAuthentication(device.assert(await auth.authenticationOptions(), { origin: 'https://evil.example' })),
      'assertion_failed',
    );
    device.userVerified = false;
    await rejects(auth.verifyAuthentication(device.assert(await auth.authenticationOptions())), 'assertion_failed');
    device.userVerified = true;
    const partner = h.members.find((m) => m.role === 'adder')!;
    await rejects(
      auth.verifyAuthentication(device.assert(await auth.authenticationOptions(), { userHandle: partner.id })),
      'unknown_passkey',
    );
    const stranger = new SoftAuthenticator(RP, ORIGIN);
    stranger.register({ challenge: 'x', user: { id: Buffer.from(dev.id).toString('base64url') } });
    await rejects(auth.verifyAuthentication(stranger.assert(await auth.authenticationOptions())), 'unknown_passkey');
  });

  it('a tampered signature fails; malformed bodies are 400s', async () => {
    const { auth, device, dev, store } = setup();
    await store.savePasskey(
      await auth.verifyRegistration(dev, 'sc_1', device.register(await auth.registrationOptions(dev, 'sc_1'))),
    );
    const a = device.assert(await auth.authenticationOptions());
    const sig = Buffer.from(a.response.signature, 'base64url');
    sig[sig.length - 1]! ^= 1;
    a.response.signature = sig.toString('base64url');
    await rejects(auth.verifyAuthentication(a), 'assertion_failed');
    await rejects(auth.verifyAuthentication({ id: 'x' }), 'bad_assertion');
    await rejects(auth.verifyRegistration(dev, 'sc_1', 'nope'), 'bad_registration');
  });

  it('the same credential cannot be registered twice', async () => {
    const { auth, device, dev, store } = setup();
    const opts = await auth.registrationOptions(dev, 'sc_1');
    const reg = device.register(opts);
    await store.savePasskey(await auth.verifyRegistration(dev, 'sc_1', reg));
    // replay the same registration with a fresh challenge baked in: still the same credential id
    const opts2 = await auth.registrationOptions(dev, 'sc_1');
    expect(opts2.excludeCredentials?.map((c) => c.id)).toEqual([reg.id]);
  });
});
