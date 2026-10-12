/**
 * Hostile review of the HTTP surface: /approve, bearer auth, and the WhatsApp webhook.
 * Tests assert the SECURE behaviour; a red test is a working exploit.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/agent/memory-store.js';
import { buildServer } from '../src/api/server.js';
import type { Household } from '../src/core/types.js';
import { StubSupplier } from '../src/suppliers/stub/index.js';
import { NOW, adder, household, owner } from './fixtures/context.js';
import { ScriptedLlm, asked, say, searchFor, use, type Step } from './fixtures/llm.js';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
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

beforeEach(() => {
  h = household();
  store = new MemoryStore([h]);
  supplier = new StubSupplier({ now: () => NOW });
});
afterEach(async () => {
  await app?.close();
});

describe('attempt 4: POST /approve', () => {
  it('4a non-owner, unknown member, never-quoted hash: refused, nothing stored or placed', async () => {
    start(flow(cart1123));
    const hash = (await post('/request', { memberId: owner(h).id, text: 'biryani' })).json().chosen.hash as string;
    expect((await post('/approve', { quoteHash: hash, memberId: adder(h).id })).statusCode).toBe(403);
    expect((await post('/approve', { quoteHash: hash, memberId: 'mem_nobody' })).statusCode).toBe(404);
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

describe('attempt 4: WhatsApp webhook', () => {
  it('4f an unknown sender is refused and nothing runs', async () => {
    start(flow(cart412));
    const r = await post('/webhooks/whatsapp', { from: '+919999999999', body: 'milk rice onions' });
    expect(r.statusCode).toBe(403);
    expect(store.requests).toHaveLength(0);
    expect(supplier.placeCalls).toBe(0);
  });

  it('4g a known adder asking for ₹412 is HELD (role)', async () => {
    start(flow(cart412));
    const r = (await post('/webhooks/whatsapp', { from: 'whatsapp:+91 00000 00002', body: 'milk rice onions' })).json();
    expect(r.result.decision.verdict).toBe('HOLD');
    expect(supplier.placeCalls).toBe(0);
  });

  /**
   * FAIL. Identity is a self-asserted body field on every route. The only secret is the shared bearer token, which
   * any household device that talks to Bazaar (an adder's Siri shortcut, the WhatsApp relay) must hold. With it,
   * the adder posts the owner's phone number as `from` (or the owner's id as `memberId` on /request or /approve) and
   * the `role` HOLD disappears: unattended PAY up to ₹500/order, ₹1,500/day — and on /approve, any amount.
   */
  it('4h FAIL: an adder holding the bearer token spoofs the owner on the webhook and gets PAY', async () => {
    start(flow(cart412));
    const ownerPhone = owner(h).channels.find((c) => c.kind === 'whatsapp')!.address;
    const r = (
      await post('/webhooks/whatsapp', { from: ownerPhone, body: 'milk rice onions (sent by the adder)' })
    ).json();
    expect(r.result.decision.verdict, 'the sender was not authenticated as the owner').not.toBe('PAY');
    expect(supplier.placeCalls).toBe(0);
  });
});
