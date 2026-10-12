import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/agent/memory-store.js';
import { buildServer } from '../src/api/server.js';
import type { Household } from '../src/core/types.js';
import { StubSupplier } from '../src/suppliers/stub/index.js';
import { NOW, adder, household, owner, placeNamed } from './fixtures/context.js';
import { ScriptedLlm, asked, say, searchFor, use, type Step } from './fixtures/llm.js';
import { PIN, WEBHOOK_SECRET, memberAuth, setPin, signed } from './fixtures/api.js';

const TOKEN = 'test-token';
/** The household read token: /ledger/summary only. */
const householdAuth = { authorization: `Bearer ${TOKEN}` };
/** Member tokens (identity comes from the token, never the body). */
let auth: Record<string, string>;
let adderAuth: Record<string, string>;

let h: Household;
let store: MemoryStore;
let supplier: StubSupplier;
let app: FastifyInstance;

function start(steps: Step[] = []) {
  app = buildServer({
    store,
    suppliers: [supplier],
    llm: new ScriptedLlm(steps),
    apiToken: TOKEN,
    webhookSecret: WEBHOOK_SECRET,
    defaultHouseholdId: h.id,
    now: () => NOW,
    model: 'test-model',
  });
}

const buildAndPropose = (lines: unknown[], text: string): Step[] => [
  searchFor('milk', 'rice', 'chicken', 'onion'),
  [use('build_cart', { lines })],
  [use('propose_checkout', {})],
  [say(text)],
];
const cart1123 = [asked('v-milk', 2, 'milk'), asked('v-rice', 1), asked('v-chicken', 2), asked('v-onion-1kg', 4)];
const cart412 = [asked('v-milk', 1), asked('v-rice', 1), asked('v-onion-1kg', 2)];

beforeEach(async () => {
  h = household();
  store = new MemoryStore([h]);
  supplier = new StubSupplier({ now: () => NOW });
  auth = await memberAuth(store, owner(h));
  await setPin(store, owner(h));
  adderAuth = await memberAuth(store, adder(h));
});
afterEach(async () => {
  await app?.close();
});

const post = (url: string, payload: unknown, headers: Record<string, string> = auth) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers });
const relay = (payload: unknown) => app.inject({ method: 'POST', url: '/webhooks/whatsapp', ...signed(payload) });

describe('auth', () => {
  it('rejects missing and wrong tokens, but serves /health', async () => {
    start();
    expect((await app.inject({ method: 'GET', url: '/places' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/places', headers: { authorization: 'Bearer nope' } })).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/places', headers: { authorization: TOKEN } })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/places', headers: auth })).statusCode).toBe(200);
  });

  it('the household token reads the ledger only; member tokens do not read the ledger', async () => {
    start();
    expect((await app.inject({ method: 'GET', url: '/places', headers: householdAuth })).statusCode).toBe(401);
    expect((await post('/request', { text: 'milk' }, householdAuth)).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/ledger/summary', headers: householdAuth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ledger/summary', headers: auth })).statusCode).toBe(401);
  });

  it('refuses to start without a token', () => {
    expect(() =>
      buildServer({ store, suppliers: [], llm: new ScriptedLlm([]), apiToken: '', defaultHouseholdId: h.id }),
    ).toThrow(/BAZAAR_API_TOKEN/);
  });
});

describe('POST /request and POST /approve', () => {
  it('₹1,123 is held; the owner approves the hash; the order places once', async () => {
    start(buildAndPropose(cart1123, 'Biryani cart for home, ₹1,123.'));
    const res = await post('/request', { memberId: owner(h).id, text: 'biryani for 6' });
    expect(res.statusCode).toBe(200);
    const result = res.json();
    expect(result.decision.verdict).toBe('HOLD');
    expect(result.summary).toMatch(/Gate: HOLD \(per_order_ceiling/);
    expect(supplier.placeCalls).toBe(0);
    const hash = result.chosen.hash as string;

    const ok = await post('/approve', { quoteHash: hash, memberId: owner(h).id, pin: PIN });
    expect(ok.statusCode).toBe(200);
    const out = ok.json();
    expect(out.decision.verdict).toBe('PAY');
    expect(out.decision.approvalId).toBe(out.approval.id);
    expect(out.placed).toBe(true);
    expect(out.gateLine).toMatch(/^Gate: PAY \(owner approval used\) — ₹1,123 placed by cash on delivery/);
    expect(supplier.placeCalls).toBe(1);
    expect(supplier.placed[0]!.payment).toEqual({ kind: 'cod' });
    expect(store.approvals[0]!.consumedAt).toBeDefined();
    expect(store.orders).toHaveLength(1);

    // Placement is idempotent per quote: approving again returns the existing order and sends nothing.
    const again = (await post('/approve', { quoteHash: hash, memberId: owner(h).id, pin: PIN })).json();
    expect(again.placed).toBe(false);
    expect(again.alreadyPlaced).toBe(true);
    expect(again.order.supplierOrderId).toBe(out.order.supplierOrderId);
    expect(again.decision.approvalId).toBe(out.approval.id);
    expect(again.requote).toBe(false);
    expect(again.approval.consumedAt).toBeDefined();
    expect(store.approvals.filter((a) => a.consumedAt === undefined)).toEqual([]);
    expect(supplier.placeCalls).toBe(1);
    expect(store.orders).toHaveLength(1);

    // A fresh quote of the same cart later is a new purchase, not a replay: the cart is gone, so the gate BLOCKs.
    await store.saveQuote(h.id, { ...result.chosen, createdAt: '2026-10-12T14:05:00.000Z' });
    const later = (await post('/approve', { quoteHash: hash, memberId: owner(h).id, pin: PIN })).json();
    expect(later.alreadyPlaced).toBeUndefined();
    expect(later.decision.verdict).toBe('BLOCK');
    expect(later.requote).toBe(true);
    expect(supplier.placeCalls).toBe(1);
  });

  it('an adder cannot approve; an unknown hash is 404; bad bodies are 400', async () => {
    start(buildAndPropose(cart1123, 'Cart for home.'));
    const hash = (await post('/request', { memberId: owner(h).id, text: 'biryani' })).json().chosen.hash as string;

    const forbidden = await post('/approve', { quoteHash: hash }, adderAuth);
    expect(forbidden.statusCode).toBe(403);
    expect(supplier.placeCalls).toBe(0);
    expect(store.approvals).toHaveLength(0);

    expect((await post('/approve', { quoteHash: 'f'.repeat(64), memberId: owner(h).id })).statusCode).toBe(404);
    expect((await post('/approve', { memberId: owner(h).id })).statusCode).toBe(400);
    expect((await post('/request', {})).statusCode).toBe(400);
    expect(
      (await post('/request', { text: 'milk' }, { authorization: `Bearer mtk_${'x'.repeat(43)}` })).statusCode,
    ).toBe(401);
  });

  it('an approval does not survive a cart that drifted: BLOCK, re-quote', async () => {
    start(buildAndPropose(cart1123, 'Cart for home.'));
    const hash = (await post('/request', { memberId: owner(h).id, text: 'biryani' })).json().chosen.hash as string;
    supplier.setPrice('v-milk', 12500);
    const out = (await post('/approve', { quoteHash: hash, memberId: owner(h).id, pin: PIN })).json();
    expect(out.decision.verdict).toBe('BLOCK');
    expect(out.requote).toBe(true);
    expect(out.placed).toBe(false);
    expect(supplier.placeCalls).toBe(0);
  });

  it('₹412 at a trusted place pays unattended end to end', async () => {
    start(buildAndPropose(cart412, 'Sorted for home, ₹412.'));
    const result = (
      await post('/request', { memberId: owner(h).id, text: 'milk rice and onions', channel: 'siri' })
    ).json();
    expect(result.decision.verdict).toBe('PAY');
    expect(result.placeReason).toBe('default');
    expect(result.summary).toMatch(/Gate: PAY \(within unattended limits\) — ₹412/);
    expect(supplier.placed).toHaveLength(1);
    expect(store.requests[0]!.channel).toBe('siri');
  });
});

describe('places', () => {
  const hospital = () => placeNamed(h, 'hospital');

  it('GET lists the places', async () => {
    start();
    const res = await app.inject({ method: 'GET', url: '/places', headers: auth });
    expect(res.json().places.map((p: { nickname: string }) => p.nickname)).toEqual([
      'home',
      'hospital',
      "rahul's",
      "didi's",
    ]);
  });

  it('POST creates an untrusted place from supplier address ids', async () => {
    start();
    const res = await post('/places', {
      nickname: 'gym',
      aliases: ['fitness'],
      canonicalAddress: 'Gym Road, Silchar',
      city: 'Silchar',
      supplierAddressIds: { instamart: 'addr-gym' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().place).toMatchObject({ nickname: 'gym', trusted: false, isDefault: false, serviceability: [] });
    const list = (await app.inject({ method: 'GET', url: '/places', headers: auth })).json().places;
    expect(list).toHaveLength(5);
  });

  it('POST validates input and rejects duplicate nicknames', async () => {
    start();
    const base = { nickname: 'gym', canonicalAddress: 'x', city: 'y', supplierAddressIds: { instamart: 'a' } };
    expect((await post('/places', { ...base, supplierAddressIds: {} })).statusCode).toBe(400);
    expect((await post('/places', { ...base, supplierAddressIds: { bogus: 'a' } })).statusCode).toBe(400);
    expect((await post('/places', { ...base, nickname: 'Home' })).statusCode).toBe(409);
  });

  it('making a place trusted needs an owner', async () => {
    start();
    const base = { nickname: 'gym', canonicalAddress: 'x', city: 'y', supplierAddressIds: { instamart: 'a' } };
    expect((await post('/places', { ...base, trusted: true }, adderAuth)).statusCode).toBe(403);
    expect((await post('/places', { ...base, trusted: true, memberId: owner(h).id }, adderAuth)).statusCode).toBe(403);
    expect((await post('/places', { ...base, trusted: true })).statusCode).toBe(201);
  });

  it('PATCH renames, trusts (owner only) and revokes trust freely', async () => {
    start();
    const patch = (payload: object, headers = auth) =>
      app.inject({ method: 'PATCH', url: `/places/${hospital().id}`, payload, headers });
    expect((await patch({ trusted: true }, adderAuth)).statusCode).toBe(403);
    expect((await patch({ trusted: true, memberId: owner(h).id }, adderAuth)).statusCode).toBe(403);
    const ok = await patch({ trusted: true, nickname: 'SCC ward' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().place).toMatchObject({ trusted: true, nickname: 'SCC ward' });
    expect((await patch({ trusted: false }, adderAuth)).json().place.trusted).toBe(false);
    expect((await patch({ nickname: 'home' })).statusCode).toBe(409);
    expect(
      (await app.inject({ method: 'PATCH', url: '/places/pl_missing', payload: { nickname: 'z' }, headers: auth }))
        .statusCode,
    ).toBe(404);
  });

  it('a newly trusted place pays unattended on the next request', async () => {
    start([...buildAndPropose(cart412, 'Done.')]);
    await app.inject({
      method: 'PATCH',
      url: `/places/${hospital().id}`,
      payload: { trusted: true, memberId: owner(h).id },
      headers: auth,
    });
    const result = (await post('/request', { memberId: owner(h).id, text: 'milk rice onions to the hospital' })).json();
    expect(result.placeReason).toBe('explicit');
    expect(result.decision.verdict).toBe('PAY');
  });
});

describe('GET /ledger/summary', () => {
  it('summarises placed orders by category, place, member and fees', async () => {
    start(buildAndPropose(cart412, 'Done.'));
    await post('/request', { memberId: owner(h).id, text: 'milk rice onions' });
    const res = await app.inject({ method: 'GET', url: '/ledger/summary?month=2026-10', headers: householdAuth });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.orderCount).toBe(1);
    expect(s.total).toBe(41200);
    expect(s.fees.total).toBe(3200);
    expect(s.byPlace).toEqual([{ key: 'home', total: 41200, count: 1 }]);
    expect(s.byMember).toEqual([{ key: 'Dev', total: 38000, count: 3 }]);
    expect(s.byCategory.map((c: { key: string }) => c.key)).toEqual(['grocery', 'dairy', 'produce']);
    // ₹380 of items is not under ₹200.
    expect(s.smallOrders.count).toBe(0);
  });

  it('defaults to the current month and validates the parameter', async () => {
    start();
    expect((await app.inject({ method: 'GET', url: '/ledger/summary', headers: householdAuth })).json().month).toBe(
      '2026-10',
    );
    expect(
      (await app.inject({ method: 'GET', url: '/ledger/summary?month=October', headers: householdAuth })).statusCode,
    ).toBe(400);
  });
});

describe('POST /webhooks/whatsapp', () => {
  it('maps the sender to a member and returns the summary as the reply', async () => {
    start(buildAndPropose(cart412, 'Sorted for home.'));
    const res = await relay({ from: 'whatsapp:+91 00000-00001', body: 'milk rice onions' });
    expect(res.statusCode).toBe(200);
    const { reply, result } = res.json();
    expect(reply).toBe(result.summary);
    expect(reply).toMatch(/Gate: PAY/);
    expect(store.requests[0]).toMatchObject({ channel: 'whatsapp', memberId: owner(h).id, text: 'milk rice onions' });
  });

  it('the partner resolves as an adder, so the same cart is held', async () => {
    start(buildAndPropose(cart412, 'Cart ready for home.'));
    const { result } = (await relay({ from: '+910000000002', body: 'milk rice onions' })).json();
    expect(result.decision.reasons.map((r: { rule: string }) => r.rule)).toContain('role');
    expect(supplier.placeCalls).toBe(0);
  });

  it('an unknown sender is refused before anything runs', async () => {
    start();
    const res = await relay({ from: '+919999999999', body: 'milk' });
    expect(res.statusCode).toBe(403);
    expect(store.requests).toHaveLength(0);
  });
});
