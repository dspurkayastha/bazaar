/**
 * Hostile review of the HTTP surface: /approve, bearer auth, and the WhatsApp webhook.
 * Tests assert the SECURE behaviour; a red test is a working exploit.
 *
 * Updated for the 4h fix (API shape change): identity now comes from per-member `mtk_...` tokens, not body
 * `memberId`; BAZAAR_API_TOKEN is only the household read token (/ledger/summary); the webhook is authenticated by
 * an HMAC signature over the raw body (x-bazaar-signature). Bodies below still carry `memberId` to show it is ignored.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/agent/memory-store.js';
import { buildServer } from '../src/api/server.js';
import type { Household } from '../src/core/types.js';
import { StubSupplier } from '../src/suppliers/stub/index.js';
import { NOW, adder, household, owner } from './fixtures/context.js';
import { ScriptedLlm, asked, say, searchFor, use, type Step } from './fixtures/llm.js';
import { WEBHOOK_SECRET, memberAuth, signed } from './fixtures/api.js';

const TOKEN = 'test-token';
let auth: Record<string, string>; // the owner's own member token
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
const flow = (lines: unknown[]): Step[] => [
  searchFor('milk', 'rice', 'chicken', 'onion'),
  [use('build_cart', { lines })],
  [use('propose_checkout', {})],
  [say('Cart for home.')],
];
const cart1123 = [asked('v-milk', 2), asked('v-rice', 1), asked('v-chicken', 2), asked('v-onion-1kg', 4)];
const cart412 = [asked('v-milk', 1), asked('v-rice', 1), asked('v-onion-1kg', 2)];
const post = (url: string, payload: unknown, headers: Record<string, string> = auth) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers });
/** What the WhatsApp relay sends: a body signed with the webhook secret. */
const relay = (payload: unknown) => app.inject({ method: 'POST', url: '/webhooks/whatsapp', ...signed(payload) });

beforeEach(async () => {
  h = household();
  store = new MemoryStore([h]);
  supplier = new StubSupplier({ now: () => NOW });
  auth = await memberAuth(store, owner(h));
  adderAuth = await memberAuth(store, adder(h));
});
afterEach(async () => {
  await app?.close();
});

describe('attempt 4: POST /approve', () => {
  it('4a non-owner, unknown member, never-quoted hash: refused, nothing stored or placed', async () => {
    start(flow(cart1123));
    const hash = (await post('/request', { memberId: owner(h).id, text: 'biryani' })).json().chosen.hash as string;
    // The adder's own token is refused, even when the body names the owner.
    expect((await post('/approve', { quoteHash: hash }, adderAuth)).statusCode).toBe(403);
    expect((await post('/approve', { quoteHash: hash, memberId: owner(h).id }, adderAuth)).statusCode).toBe(403);
    // Unknown, revoked or household-level credentials never reach the route.
    const nobody = { authorization: `Bearer mtk_${'A'.repeat(43)}` };
    expect((await post('/approve', { quoteHash: hash, memberId: 'mem_nobody' }, nobody)).statusCode).toBe(401);
    const old = auth;
    auth = await memberAuth(store, owner(h)); // rotation revokes the previous token
    expect((await post('/approve', { quoteHash: hash }, old)).statusCode).toBe(401);
    expect(
      (await post('/approve', { quoteHash: hash }, { authorization: `Bearer ${TOKEN}` })).statusCode,
      'the household token cannot approve',
    ).toBe(401);
    expect((await post('/approve', { quoteHash: 'a'.repeat(64), memberId: owner(h).id })).statusCode).toBe(404);
    expect((await post('/approve', { quoteHash: hash.toUpperCase(), memberId: owner(h).id })).statusCode).toBe(404);
    expect((await post('/approve', { quoteHash: [hash], memberId: owner(h).id })).statusCode).toBe(400);
    expect(store.approvals).toHaveLength(0);
    expect(supplier.placeCalls).toBe(0);
  });

  it('4b approve twice → one order; approve, cart changes, approve again → BLOCK', async () => {
    start(flow(cart1123));
    const hash = (await post('/request', { memberId: owner(h).id, text: 'biryani' })).json().chosen.hash as string;
    expect((await post('/approve', { quoteHash: hash, memberId: owner(h).id })).json().placed).toBe(true);
    const again = (await post('/approve', { quoteHash: hash, memberId: owner(h).id })).json();
    expect(again.placed).toBe(false);
    expect(supplier.placeCalls).toBe(1);
  });

  it('4c approve after the cart changed → BLOCK; approving the old hash again → BLOCK; nothing placed', async () => {
    start(flow(cart1123));
    const hash = (await post('/request', { memberId: owner(h).id, text: 'biryani' })).json().chosen.hash as string;
    supplier.addOutsideSession('v-chicken', 3);
    const a1 = (await post('/approve', { quoteHash: hash, memberId: owner(h).id })).json();
    expect(a1.decision.verdict).toBe('BLOCK');
    const a2 = (await post('/approve', { quoteHash: hash, memberId: owner(h).id })).json();
    expect(a2.decision.verdict).toBe('BLOCK');
    expect(supplier.placeCalls).toBe(0);
  });

  it('4d concurrent double-tap on /approve: at most one order (stub clears the cart; see review-instamart 5c)', async () => {
    start(flow(cart1123));
    const hash = (await post('/request', { memberId: owner(h).id, text: 'biryani' })).json().chosen.hash as string;
    const rs = await Promise.all([
      post('/approve', { quoteHash: hash, memberId: owner(h).id }),
      post('/approve', { quoteHash: hash, memberId: owner(h).id }),
    ]);
    expect(supplier.placed).toHaveLength(1);
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200]);
    // Fix (gate lock + idempotent placement): the second tap queues behind the first and gets the first's order
    // back without calling the supplier (alreadyPlaced). Before the fix it happened to read the emptied cart (BLOCK).
    const bodies = rs.map((r) => r.json());
    expect(bodies.map((b) => b.placed).sort()).toEqual([false, true]);
    const replay = bodies.find((b) => !b.placed);
    expect(replay.alreadyPlaced).toBe(true);
    expect(replay.order.supplierOrderId).toBe(supplier.placed[0]!.order.supplierOrderId);
    // Neither tap leaves a live approval behind: the paying one is consumed by the order, the replay's on replay.
    expect(store.approvals).toHaveLength(2);
    expect(store.approvals.filter((a) => a.consumedAt === undefined)).toEqual([]);
    expect(replay.approval.consumedAt).toBe(NOW);
  });
});

describe('attempt 4: bearer auth', () => {
  it('4e no bypass via path tricks, header case, or whitespace', async () => {
    start(flow(cart1123));
    const tries: [string, Record<string, string>][] = [
      ['/approve', {}],
      ['/approve', { authorization: `bearer ${TOKEN}` }],
      ['/approve', { authorization: `Bearer  ${TOKEN}` }],
      ['/approve', { authorization: `Bearer ${TOKEN} ` }],
      ['/approve', { authorization: `Basic ${TOKEN}` }],
      ['/health/../approve', {}],
      ['//approve', {}],
      ['/approve?/health', {}],
      ['/health?x=/approve', {}],
      ['/%61pprove', {}],
      ['/Approve', {}],
      ['/request', { authorization: 'Bearer ' }],
    ];
    for (const [url, headers] of tries) {
      const r = await app.inject({
        method: 'POST',
        url,
        payload: { quoteHash: 'x', memberId: 'y', text: 'z' },
        headers,
      });
      expect([401, 404], `${url} ${JSON.stringify(headers)} → ${r.statusCode}`).toContain(r.statusCode);
    }
    expect(supplier.placeCalls).toBe(0);
  });
});

describe('attempt 4: identity on /request', () => {
  it('4i the body cannot choose the member: an adder naming the owner is still the adder (HOLD, role)', async () => {
    start(flow(cart412));
    const r = (await post('/request', { memberId: owner(h).id, text: 'milk rice onions' }, adderAuth)).json();
    expect(store.requests[0]!.memberId).toBe(adder(h).id);
    expect(r.decision.verdict).toBe('HOLD');
    expect(r.decision.reasons.map((x: { rule: string }) => x.rule)).toContain('role');
    expect(supplier.placeCalls).toBe(0);
  });
});

describe('attempt 4: WhatsApp webhook', () => {
  it('4f an unknown sender is refused and nothing runs', async () => {
    start(flow(cart412));
    const r = await relay({ from: '+919999999999', body: 'milk rice onions' });
    expect(r.statusCode).toBe(403);
    expect(store.requests).toHaveLength(0);
    expect(supplier.placeCalls).toBe(0);
  });

  it('4g a known adder asking for ₹412 is HELD (role)', async () => {
    start(flow(cart412));
    const r = (await relay({ from: 'whatsapp:+91 00000 00002', body: 'milk rice onions' })).json();
    expect(r.result.decision.verdict).toBe('HOLD');
    expect(supplier.placeCalls).toBe(0);
  });

  /**
   * Was FAIL. Identity was a self-asserted body field on every route and the only secret was the shared bearer token.
   * Now: the webhook needs the relay's HMAC signature (the adder has the household token and their own member token,
   * neither of which signs), and a webhook request is HELD unless it is an owner's channel marked trusted.
   */
  it('4h an adder holding the bearer tokens cannot spoof the owner on the webhook', async () => {
    start(flow(cart412));
    const ownerPhone = owner(h).channels.find((c) => c.kind === 'whatsapp')!.address;
    const spoof = { from: ownerPhone, body: 'milk rice onions (sent by the adder)' };
    for (const headers of [{ authorization: `Bearer ${TOKEN}` }, adderAuth, auth]) {
      expect((await post('/webhooks/whatsapp', spoof, headers)).statusCode, 'unsigned').toBe(401);
    }
    const forged = signed(spoof, 'guessed-secret');
    expect((await app.inject({ method: 'POST', url: '/webhooks/whatsapp', ...forged })).statusCode).toBe(401);
    // Signature over different bytes than the body sent.
    const tampered = { ...signed({ ...spoof, from: adder(h).channels[0]!.address }), payload: JSON.stringify(spoof) };
    expect((await app.inject({ method: 'POST', url: '/webhooks/whatsapp', ...tampered })).statusCode).toBe(401);
    expect(store.requests).toHaveLength(0);
    expect(supplier.placeCalls).toBe(0);
  });

  it("4h' even a correctly signed owner message is HELD unless the owner's channel is marked trusted", async () => {
    for (const c of store.households.get(h.id)!.members.flatMap((m) => m.channels)) delete c.trusted;
    start(flow(cart412));
    const ownerPhone = owner(h).channels.find((c) => c.kind === 'whatsapp')!.address;
    const r = (await relay({ from: ownerPhone, body: 'milk rice onions' })).json();
    expect(r.result.decision.verdict, 'a webhook sender is not authenticated as the owner').not.toBe('PAY');
    expect(r.result.decision.reasons.map((x: { rule: string }) => x.rule)).toContain('channel_untrusted');
    expect(supplier.placeCalls).toBe(0);
  });

  it("4h'' a webhook request never uses an approval, even the owner's on that exact hash", async () => {
    start([...flow(cart1123), ...flow(cart1123)]);
    const hash = (await post('/request', { text: 'biryani' })).json().chosen.hash as string;
    await store.saveApproval({
      id: 'ap_left_over',
      quoteHash: hash,
      memberId: owner(h).id,
      createdAt: NOW,
      expiresAt: '2026-10-12T14:30:00.000Z',
    });
    const ownerPhone = owner(h).channels.find((c) => c.kind === 'whatsapp')!.address;
    const r = (await relay({ from: ownerPhone, body: 'biryani' })).json();
    expect(r.result.chosen.hash).toBe(hash);
    expect(r.result.decision.verdict).toBe('HOLD');
    expect(supplier.placeCalls).toBe(0);
  });

  it('4j the webhook refuses everything when no secret is configured', async () => {
    app = buildServer({
      store,
      suppliers: [supplier],
      llm: new ScriptedLlm(flow(cart412)),
      apiToken: TOKEN,
      defaultHouseholdId: h.id,
      now: () => NOW,
      model: 'test-model',
    });
    const ownerPhone = owner(h).channels.find((c) => c.kind === 'whatsapp')!.address;
    expect((await relay({ from: ownerPhone, body: 'milk' })).statusCode).toBe(503);
    expect(store.requests).toHaveLength(0);
  });
});
