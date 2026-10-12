/**
 * The web app's server side (docs/WEB_API.md): passkey setup and sign-in (real WebAuthn verification against a
 * software authenticator), sessions, CSRF, PIN, held carts, approve / reject, household management, ledger.
 * No network: in-process Fastify inject, StubSupplier, scripted LLM.
 */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/agent/memory-store.js';
import { PIN_LOCK_MS } from '../src/auth/pin.js';
import { SESSION_TTL_MS, SessionService, createSetupLink } from '../src/auth/session.js';
import { buildServer } from '../src/api/server.js';
import type { Household, Member } from '../src/core/types.js';
import { StubSupplier } from '../src/suppliers/stub/index.js';
import { InstamartSupplier } from '../src/suppliers/instamart/adapter.js';
import { adder, household, owner, placeNamed } from './fixtures/context.js';
import { PIN, memberAuth, setPin } from './fixtures/api.js';
import { fakeTool, fixture } from './fixtures/instamart/harness.js';
import { ScriptedLlm, asked, say, searchFor, use, type Step } from './fixtures/llm.js';
import { SoftAuthenticator } from './fixtures/webauthn.js';

const ORIGIN = 'https://bazaar.test';
const RP_ID = 'bazaar.test';
const T0 = Date.parse('2026-10-12T14:00:00.000Z');

let h: Household;
let store: MemoryStore;
let supplier: StubSupplier;
let app: FastifyInstance;
let now: number;
const iso = () => new Date(now).toISOString();

function start(steps: Step[] = [], extra: { suppliers?: unknown[] } = {}) {
  app = buildServer({
    store,
    suppliers: (extra.suppliers as StubSupplier[] | undefined) ?? [supplier],
    llm: new ScriptedLlm(steps),
    apiToken: 'test-token',
    defaultHouseholdId: h.id,
    now: iso,
    model: 'test-model',
    web: { origin: ORIGIN, rpId: RP_ID },
  });
  return app;
}

beforeEach(() => {
  h = household();
  store = new MemoryStore([h]);
  now = T0;
  supplier = new StubSupplier({ now: iso });
});
afterEach(async () => {
  await app?.close();
});

const CSRF = { 'x-bazaar': '1' };

async function sessionFor(member: Member): Promise<string> {
  const { token } = await new SessionService(store, iso).create(member);
  return `bz_session=${token}`;
}

function cookieOf(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const c = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  return c.split(';')[0]!;
}

const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
const post = (url: string, payload: unknown, cookie?: string, headers: Record<string, string> = CSRF) =>
  app.inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
  });
const patch = (url: string, payload: unknown, cookie?: string) =>
  app.inject({ method: 'PATCH', url, payload: payload as object, headers: { ...CSRF, ...(cookie ? { cookie } : {}) } });

// ---------- carts made through the real agent loop + gate ----------

const cart1123 = [asked('v-milk', 2, 'milk'), asked('v-rice', 1), asked('v-chicken', 2), asked('v-onion-1kg', 4)];
const cart412 = [asked('v-milk', 1), asked('v-rice', 1), asked('v-onion-1kg', 2)];
const buildAndPropose = (lines: unknown[], text = 'Cart built.'): Step[] => [
  searchFor('milk', 'rice', 'chicken', 'onion'),
  [use('build_cart', { lines })],
  [use('propose_checkout', {})],
  [say(text)],
];

async function holdCart(member: Member, text: string): Promise<{ hash: string; total: number }> {
  const res = await app.inject({
    method: 'POST',
    url: '/request',
    payload: { text },
    headers: await memberAuth(store, member),
  });
  const r = res.json();
  expect(r.decision.verdict).toBe('HOLD');
  return { hash: r.chosen.hash, total: r.chosen.total };
}

describe('passkey setup → sign-in → session (real WebAuthn verification)', () => {
  it('a setup link registers a passkey once, signs in, and later discoverable sign-in works', async () => {
    start();
    const dev = owner(h);
    const { url, expiresAt } = await createSetupLink(store, {
      memberId: dev.id,
      householdId: h.id,
      origin: ORIGIN,
      now: iso(),
    });
    expect(url).toMatch(/^https:\/\/bazaar\.test\/setup\/[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(expiresAt) - now).toBe(48 * 3_600_000);
    const code = url.split('/').at(-1)!;
    // only the hash is stored
    expect(JSON.stringify([...store.setupCodes.values()])).not.toContain(code);

    const device = new SoftAuthenticator(RP_ID, ORIGIN);
    const optRes = await post(`/api/setup/${code}/options`, {});
    expect(optRes.statusCode).toBe(200);
    const opts = optRes.json();
    expect(opts.member).toEqual({ name: 'Dev' });
    expect(opts.rp.id).toBe(RP_ID);
    const verify = await post(`/api/setup/${code}/verify`, device.register(opts));
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toEqual({ ok: true });
    const setCookie = String(verify.headers['set-cookie']);
    expect(setCookie).toMatch(
      /^bz_session=bzs_[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/,
    );
    const cookie = cookieOf(verify);
    // the session token is stored hashed only
    expect(JSON.stringify([...store.sessions.values()])).not.toContain(cookie.split('=')[1]);

    const me = await get('/api/me', cookie);
    expect(me.json()).toEqual({
      member: { id: dev.id, name: 'Dev', role: 'owner' },
      household: { id: h.id, name: h.name },
      pinSet: false,
      pinLocked: false,
    });

    // the link is single use
    const again = await post(`/api/setup/${code}/options`, {});
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('setup_invalid');

    // logout revokes the session and clears the cookie
    const out = await post('/api/logout', {}, cookie);
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toMatch(/^bz_session=; .*Max-Age=0/);
    expect((await get('/api/me', cookie)).statusCode).toBe(401);

    // sign in again with the passkey (no username)
    const login = (await post('/api/login/options', {})).json();
    const res = await post('/api/login/verify', device.assert(login));
    expect(res.statusCode).toBe(200);
    expect((await get('/api/me', cookieOf(res))).json().member.id).toBe(dev.id);
    expect(store.securityEvents.map((e) => e.kind)).toEqual(['setup_link_created', 'passkey_registered']);
  });

  it('setup links expire after 48 h; a newer link revokes the older one', async () => {
    start();
    const p = adder(h);
    const first = await createSetupLink(store, { memberId: p.id, householdId: h.id, origin: ORIGIN, now: iso() });
    const second = await createSetupLink(store, { memberId: p.id, householdId: h.id, origin: ORIGIN, now: iso() });
    expect((await post(`/api/setup/${first.url.split('/').at(-1)}/options`, {})).statusCode).toBe(404);
    now += 48 * 3_600_000;
    expect((await post(`/api/setup/${second.url.split('/').at(-1)}/options`, {})).statusCode).toBe(404);
    expect((await post('/api/setup/not-a-code/options', {})).statusCode).toBe(404);
  });

  it('an assertion from an unregistered passkey or the wrong origin does not sign in', async () => {
    start();
    const stranger = new SoftAuthenticator(RP_ID, ORIGIN);
    stranger.register({ challenge: 'x', user: { id: Buffer.from(owner(h).id).toString('base64url') } });
    const res = await post('/api/login/verify', stranger.assert((await post('/api/login/options', {})).json()));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unknown_passkey');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('sessions and CSRF', () => {
  it('30-day sliding expiry: use keeps it alive, 30 idle days end it', async () => {
    start();
    const cookie = await sessionFor(owner(h));
    now += 29 * 86_400_000;
    const r1 = await get('/api/me', cookie);
    expect(r1.statusCode).toBe(200);
    expect(String(r1.headers['set-cookie'])).toMatch(/Max-Age=2592000/); // slid and re-sent
    now += 29 * 86_400_000; // 58 days after sign-in, 29 after last use
    expect((await get('/api/me', cookie)).statusCode).toBe(200);
    now += SESSION_TTL_MS; // 30 idle days
    const dead = await get('/api/me', cookie);
    expect(dead.statusCode).toBe(401);
    expect(dead.json()).toEqual({ error: { code: 'unauthorised', message: 'Sign in first.' } });
  });

  it('no cookie, a garbage cookie, or a member token instead of a session → 401', async () => {
    start();
    expect((await get('/api/me')).statusCode).toBe(401);
    expect((await get('/api/me', 'bz_session=bzs_' + 'x'.repeat(43))).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: await memberAuth(store, owner(h)) });
    expect(res.statusCode).toBe(401);
  });

  it('every non-GET /api request needs X-Bazaar: 1 (before auth); GETs do not', async () => {
    start();
    const cookie = await sessionFor(owner(h));
    for (const [url, c] of [
      ['/api/logout', cookie],
      ['/api/login/options', undefined],
      ['/api/household/members', cookie],
    ] as const) {
      const res = await post(url, {}, c, {});
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('csrf');
    }
    expect((await post('/api/logout', {}, cookie, { 'x-bazaar': 'yes' })).statusCode).toBe(403);
    expect((await get('/api/me', cookie)).statusCode).toBe(200);
  });
});

describe('PIN', () => {
  async function enrolled(member: Member) {
    const device = new SoftAuthenticator(RP_ID, ORIGIN);
    const { url } = await createSetupLink(store, {
      memberId: member.id,
      householdId: h.id,
      origin: ORIGIN,
      now: iso(),
    });
    const code = url.split('/').at(-1)!;
    const res = await post(
      `/api/setup/${code}/verify`,
      device.register((await post(`/api/setup/${code}/options`, {})).json()),
    );
    expect(res.statusCode).toBe(200);
    return { device, cookie: cookieOf(res) };
  }
  const fresh = async (device: SoftAuthenticator) => device.assert((await post('/api/login/options', {})).json());

  it('setting a PIN needs a fresh passkey assertion by the same owner in the same request', async () => {
    start();
    const dev = await enrolled(owner(h));
    const partner = await enrolled(adder(h));

    expect((await post('/api/pin', { pin: PIN }, dev.cookie)).json().error.code).toBe('assertion_required');
    expect(
      (await post('/api/pin', { pin: '12', assertion: await fresh(dev.device) }, dev.cookie)).json().error.code,
    ).toBe('pin_invalid');
    const someoneElse = await post('/api/pin', { pin: PIN, assertion: await fresh(partner.device) }, dev.cookie);
    expect(someoneElse.statusCode).toBe(403);
    expect(someoneElse.json().error.code).toBe('assertion_mismatch');
    // an assertion is single use
    const a = await fresh(dev.device);
    expect((await post('/api/pin', { pin: PIN, assertion: a }, dev.cookie)).statusCode).toBe(200);
    const replay = await post('/api/pin', { pin: '9999', assertion: a }, dev.cookie);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('challenge_expired');
    // stale challenge (> 5 min)
    const opts = (await post('/api/login/options', {})).json();
    now += 5 * 60_000;
    expect((await post('/api/pin', { pin: '9999', assertion: dev.device.assert(opts) }, dev.cookie)).statusCode).toBe(
      401,
    );
    // adders cannot set a PIN at all
    expect(
      (await post('/api/pin', { pin: PIN, assertion: await fresh(partner.device) }, partner.cookie)).statusCode,
    ).toBe(403);

    const me = (await get('/api/me', dev.cookie)).json();
    expect(me).toMatchObject({ pinSet: true, pinLocked: false });
    expect(JSON.stringify(me)).not.toContain(PIN);
    expect(JSON.stringify(store.securityEvents)).not.toContain(PIN);
    expect(store.pins.get(owner(h).id)!.hash).toMatch(/^scrypt\$32768\$8\$1\$/);
  });

  it('lockout: 5 wrong PINs → 423 for 15 minutes (event recorded); 10 in 24 h → locked until reset', async () => {
    start(buildAndPropose(cart1123));
    await setPin(store, owner(h));
    const cookie = await sessionFor(owner(h));
    const { hash } = await holdCart(owner(h), 'biryani for 6');
    const approve = (pin: string) => post(`/api/carts/${hash}/approve`, { pin }, cookie);
    for (let i = 0; i < 4; i++) {
      const r = await approve('0000');
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error: { code: 'pin_incorrect' }, attemptsLeft: 4 - i });
    }
    const fifth = await approve('0000');
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json()).toMatchObject({ error: { code: 'pin_locked' }, pinLocked: true });
    expect((await approve(PIN)).statusCode).toBe(423); // even the right PIN
    expect((await get('/api/me', cookie)).json()).toMatchObject({ pinLocked: true });
    expect(store.securityEvents.some((e) => e.kind === 'pin_locked')).toBe(true);
    expect(supplier.placeCalls).toBe(0);
    expect(store.approvals).toHaveLength(0);

    now += PIN_LOCK_MS;
    for (let i = 0; i < 4; i++) expect((await approve('1111')).statusCode).toBe(403);
    const tenth = await approve('1111');
    expect(tenth.statusCode).toBe(423);
    expect(tenth.json()).toMatchObject({ hardLocked: true });
    now += 24 * 3_600_000;
    expect((await approve(PIN)).statusCode).toBe(423);
    expect(store.securityEvents.map((e) => e.kind)).toContain('pin_hard_locked');
  });
});

describe('held carts, approve and reject', () => {
  it('above ₹500: needsPin until the PIN comes with the approve; then the gate places', async () => {
    start(buildAndPropose(cart1123));
    await setPin(store, owner(h));
    const cookie = await sessionFor(owner(h));
    const { hash, total } = await holdCart(owner(h), 'biryani for 6');
    expect(total).toBe(112300);

    const carts = (await get('/api/carts', cookie)).json();
    expect(carts.held).toHaveLength(1);
    expect(carts.held[0]).toMatchObject({
      quoteHash: hash,
      member: { id: owner(h).id, name: 'Dev' },
      place: { nickname: 'home' },
      supplier: 'instamart',
      total: 112300,
      needsPin: true,
      approvable: true,
    });
    expect(carts.held[0].lines[0]).toEqual({
      name: expect.any(String),
      label: expect.any(String),
      qty: 2,
      lineTotal: 24000,
    });
    expect(carts.held[0].reasons.join(' ')).toMatch(/1,123/);

    const noPin = await post(`/api/carts/${hash}/approve`, {}, cookie);
    expect(noPin.statusCode).toBe(200);
    expect(noPin.json()).toMatchObject({
      needsPin: true,
      decision: { verdict: 'HOLD', reasons: [{ rule: 'pin_required' }] },
    });
    expect(store.approvals).toHaveLength(0);
    expect(supplier.placeCalls).toBe(0);

    const ok = await post(`/api/carts/${hash}/approve`, { pin: PIN }, cookie);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ decision: { verdict: 'PAY' }, order: { status: 'placed' } });
    expect(ok.json().needsPin).toBeUndefined();
    expect(supplier.placeCalls).toBe(1);
    const after = (await get('/api/carts', cookie)).json();
    expect(after.held).toEqual([]);
    expect(after.recent[0]).toMatchObject({ total: 112300, place: { nickname: 'home' }, member: { name: 'Dev' } });
  });

  it('the threshold is exact paise: a ₹1,123 cart needs no PIN when the threshold is ₹1,123', async () => {
    store = new MemoryStore([h]);
    app = buildServer({
      store,
      suppliers: [supplier],
      llm: new ScriptedLlm(buildAndPropose(cart1123)),
      apiToken: 'test-token',
      defaultHouseholdId: h.id,
      now: iso,
      model: 'test-model',
      web: { origin: ORIGIN, rpId: RP_ID },
      pinRequiredAbovePaise: 112300,
    });
    const cookie = await sessionFor(owner(h));
    const { hash } = await holdCart(owner(h), 'biryani for 6');
    expect((await get('/api/carts', cookie)).json().held[0].needsPin).toBe(false);
    expect((await post(`/api/carts/${hash}/approve`, {}, cookie)).json().decision.verdict).toBe('PAY');
  });

  it('at or under ₹500 a tap approves (no PIN); BLOCK is never approvable', async () => {
    start([
      ...buildAndPropose(cart412),
      searchFor('cooker'),
      [use('build_cart', { lines: [asked('v-cooker', 1)] })],
      [use('propose_checkout', {})],
      [say('Blocked.')],
    ]);
    const cookie = await sessionFor(owner(h));
    const { hash } = await holdCart(owner(h), 'milk rice onion for the hospital');
    const held = (await get('/api/carts', cookie)).json().held;
    expect(held[0]).toMatchObject({ needsPin: false, approvable: true, place: { nickname: 'hospital' } });
    expect((await post(`/api/carts/${hash}/approve`, {}, cookie)).json().decision.verdict).toBe('PAY');

    const blocked = await app.inject({
      method: 'POST',
      url: '/request',
      payload: { text: 'pressure cooker' },
      headers: await memberAuth(store, owner(h)),
    });
    const bh = blocked.json().chosen.hash as string;
    const view = (await get('/api/carts', cookie)).json().held.find((c: { quoteHash: string }) => c.quoteHash === bh);
    expect(view).toMatchObject({ approvable: false, needsPin: true });
    await setPin(store, owner(h));
    const tried = await post(`/api/carts/${bh}/approve`, { pin: PIN }, cookie);
    expect(tried.json().decision.verdict).toBe('BLOCK');
    expect(supplier.placeCalls).toBe(1);
  });

  it('visibility by role: owners see every held cart, an adder only their own; adders cannot approve', async () => {
    start([...buildAndPropose(cart412), ...buildAndPropose(cart1123)]);
    const p = adder(h);
    const pc = await sessionFor(p);
    const oc = await sessionFor(owner(h));
    const theirs = await holdCart(p, 'milk rice onion'); // HOLD (role)
    const mine = await holdCart(owner(h), 'biryani for 6');
    const ownerView = (await get('/api/carts', oc)).json().held.map((c: { quoteHash: string }) => c.quoteHash);
    expect(ownerView.sort()).toEqual([theirs.hash, mine.hash].sort());
    const adderView = (await get('/api/carts', pc)).json().held;
    expect(adderView.map((c: { quoteHash: string }) => c.quoteHash)).toEqual([theirs.hash]);
    expect(adderView[0]).toMatchObject({ approvable: false, member: { name: 'Partner' } });
    const denied = await post(`/api/carts/${theirs.hash}/approve`, {}, pc);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('owner_required');
  });

  it('reject: the builder or an owner; clears the supplier cart only while it still holds that quote', async () => {
    start([...buildAndPropose(cart412), ...buildAndPropose(cart412)]);
    const p = adder(h);
    const pc = await sessionFor(p);
    const oc = await sessionFor(owner(h));
    const theirs = await holdCart(p, 'milk rice onion');
    expect((await supplier.readCart(placeNamed(h, 'home'))).hash).toBe(theirs.hash);

    // another adder cannot reject it
    const other = (await post('/api/household/members', { name: 'Ma', role: 'adder', phones: [] }, oc)).json();
    const oc2 = await sessionFor({ ...p, id: other.id, name: 'Ma' });
    expect((await post(`/api/carts/${theirs.hash}/reject`, {}, oc2)).statusCode).toBe(403);

    const r = await post(`/api/carts/${theirs.hash}/reject`, {}, pc);
    expect(r.json()).toEqual({ ok: true, cleared: true });
    expect((await supplier.readCart(placeNamed(h, 'home'))).lines).toEqual([]);
    expect((await get('/api/carts', oc)).json().held).toEqual([]);

    // a cart that changed since: rejected, but the (different) live cart is left alone
    const again = await holdCart(owner(h), 'milk rice onion for the hospital');
    supplier.setPrice('v-milk', 12500);
    const r2 = await post(`/api/carts/${again.hash}/reject`, {}, oc);
    expect(r2.json()).toEqual({ ok: true, cleared: false });
    expect((await supplier.readCart(placeNamed(h, 'hospital'))).lines.length).toBeGreaterThan(0);
    expect((await post(`/api/carts/${'f'.repeat(64)}/reject`, {}, oc)).statusCode).toBe(404);
  });

  it('the legacy bearer /approve follows the same PIN rule', async () => {
    start(buildAndPropose(cart1123));
    await setPin(store, owner(h));
    const { hash } = await holdCart(owner(h), 'biryani');
    const auth = await memberAuth(store, owner(h)); // (issuing a token rotates the one holdCart used)
    const noPin = await app.inject({ method: 'POST', url: '/approve', payload: { quoteHash: hash }, headers: auth });
    expect(noPin.json()).toMatchObject({ needsPin: true, placed: false });
    const wrong = await app.inject({
      method: 'POST',
      url: '/approve',
      payload: { quoteHash: hash, pin: '0000' },
      headers: auth,
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ error: 'Wrong PIN.', attemptsLeft: 4 });
    expect(supplier.placeCalls).toBe(0);
  });
});

describe('household', () => {
  it('members: phones are E.164, normalised and unique across the household; owners only', async () => {
    start();
    const oc = await sessionFor(owner(h));
    const pc = await sessionFor(adder(h));
    const created = await post(
      '/api/household/members',
      { name: 'Ma', role: 'dependant', phones: ['+91 98640 12345'], defaultPlaceId: placeNamed(h, "rahul's").id },
      oc,
    );
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'Ma',
      role: 'dependant',
      phones: ['+919864012345'],
      hasPasskey: false,
    });

    const dup = await post('/api/household/members', { name: 'Baba', role: 'adder', phones: ['+919864012345'] }, oc);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('phone_taken');
    expect((await post('/api/household/members', { name: 'X', phones: ['98640 12345'] }, oc)).json().error.code).toBe(
      'bad_phone',
    );
    expect((await post('/api/household/members', { name: 'X', role: 'king' }, oc)).statusCode).toBe(400);
    expect((await post('/api/household/members', { name: 'X' }, pc)).statusCode).toBe(403);

    const devPhone = await patch(`/api/household/members/${owner(h).id}`, { phones: ['+919864012345'] }, oc);
    expect(devPhone.statusCode).toBe(409);
    const ok = await patch(`/api/household/members/${owner(h).id}`, { phones: ['+919800000001'] }, oc);
    expect(ok.json().phones).toEqual(['+919800000001']);
    // the store enforces it too (DB: member_phones primary key)
    await expect(store.saveMember({ ...adder(h), phones: ['+919800000001'] })).rejects.toThrow(/already belongs/);
    // the last owner cannot be demoted
    expect((await patch(`/api/household/members/${owner(h).id}`, { role: 'adder' }, oc)).json().error.code).toBe(
      'last_owner',
    );

    const hh = (await get('/api/household', pc)).json();
    expect(hh.members.map((m: { name: string }) => m.name)).toEqual(['Dev', 'Partner', 'Ma']);
    expect(hh.places.map((p: { key: string }) => p.key)).toEqual(['home', 'hospital', 'rahuls', 'didis']);
    expect(hh.places[0]).toEqual({
      id: placeNamed(h, 'home').id,
      key: 'home',
      nickname: 'home',
      aliases: ['house', 'ambicapatty'],
      city: 'Silchar',
      trusted: true,
      isDefault: true,
      supplierAddressIds: { instamart: expect.any(String) },
      serviceability: [],
    });
  });

  it('setup links from the web: owner only, shown once', async () => {
    start();
    const oc = await sessionFor(owner(h));
    const pc = await sessionFor(adder(h));
    const res = await post(`/api/household/members/${adder(h).id}/setup-link`, {}, oc);
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toMatch(/^https:\/\/bazaar\.test\/setup\/[A-Za-z0-9_-]{43}$/);
    expect((await post(`/api/household/members/${adder(h).id}/setup-link`, {}, pc)).statusCode).toBe(403);
    expect((await post('/api/household/members/mem_nobody/setup-link', {}, oc)).statusCode).toBe(404);
  });

  it('places: import an unmapped Instamart address in one tap (Guwahati); keys are slugs', async () => {
    const tool = fakeTool({ get_addresses: fixture('get_addresses_household') });
    const instamart = new InstamartSupplier({ callTool: tool.callTool, now: iso });
    start([], { suppliers: [supplier, instamart] });
    const oc = await sessionFor(owner(h));
    const list = (await get('/api/household/supplier-addresses', oc)).json();
    expect(list.available).toBe(true);
    expect(list.addresses).toHaveLength(1); // home, hospital and Rahul's are already places
    const guwahati = list.addresses[0];
    expect(guwahati).toEqual({
      id: 'e1guwahati0000000000__AXmaskedGuwahati00001',
      tag: 'Ma',
      category: 'Friends & Family',
      addressLine: expect.any(String),
    });
    expect(JSON.stringify(list)).not.toMatch(/1187|phone/i);

    const created = await post(
      '/api/household/places',
      { nickname: "Ma's flat", aliases: ['guwahati'], city: 'Guwahati', instamartAddressId: guwahati.id },
      oc,
    );
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      key: 'mas-flat',
      trusted: false,
      isDefault: false,
      supplierAddressIds: { instamart: guwahati.id },
    });
    expect((await get('/api/household/supplier-addresses', oc)).json().addresses).toEqual([]);
    expect(
      (
        await post(
          '/api/household/places',
          { nickname: 'again', city: 'Guwahati', instamartAddressId: guwahati.id },
          oc,
        )
      ).statusCode,
    ).toBe(409);
    expect((await post('/api/household/places', { nickname: 'home', city: 'Silchar' }, oc)).statusCode).toBe(409);

    const id = created.json().id as string;
    const patched = await patch(`/api/household/places/${id}`, { trusted: true, nickname: 'ma' }, oc);
    expect(patched.json()).toMatchObject({ trusted: true, nickname: 'ma', key: 'mas-flat' });
    expect((await patch(`/api/household/places/${id}`, { trusted: true }, await sessionFor(adder(h)))).statusCode).toBe(
      403,
    );
  });

  it('supplier addresses without Instamart configured: an empty list, not an error', async () => {
    start();
    expect((await get('/api/household/supplier-addresses', await sessionFor(owner(h)))).json()).toEqual({
      addresses: [],
      available: false,
    });
  });
});

describe('ledger', () => {
  it('owner sees the household month; others only their own lines', async () => {
    start([...buildAndPropose(cart412), ...buildAndPropose(cart412)]);
    // the owner's ₹412 order to home (trusted, under the caps → PAY) plus one the partner placed
    const oc = await sessionFor(owner(h));
    const pc = await sessionFor(adder(h));
    await app.inject({
      method: 'POST',
      url: '/request',
      payload: { text: 'milk rice onion' },
      headers: await memberAuth(store, owner(h)),
    });
    store.addLedgerOrder(h.id, {
      supplierId: 'instamart',
      supplierOrderId: 'o-partner',
      placedAt: iso(),
      placeId: placeNamed(h, 'home').id,
      memberId: adder(h).id,
      lines: [{ name: 'curd', quantity: 1, unitPrice: 5000, lineTotal: 5000, addedBy: adder(h).id }],
      fees: [{ label: 'delivery', amount: 2500 }],
      total: 7500,
      status: 'placed',
    });
    const all = (await get('/api/ledger?month=2026-10', oc)).json();
    expect(all.orderCount).toBe(2);
    expect(all.total).toBe(41200 + 7500);
    const own = (await get('/api/ledger?month=2026-10', pc)).json();
    expect(own.orderCount).toBe(1);
    expect(own.total).toBe(7500);
    expect((await get('/api/ledger?month=2026-13', oc)).statusCode).toBe(400);
  });
});
