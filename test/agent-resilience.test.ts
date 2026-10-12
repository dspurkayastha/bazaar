import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/agent/memory-store.js';
import { cleanFinalText, runShopRequestDetailed, type AgentDeps } from '../src/agent/loop.js';
import { buildServer } from '../src/api/server.js';
import { SupplierError } from '../src/core/errors.js';
import type { CartLine, Household, Place, Quote, ShopRequest, SupplierProduct } from '../src/core/types.js';
import { StubSupplier } from '../src/suppliers/stub/index.js';
import { NOW, household, owner, placeNamed } from './fixtures/context.js';
import { memberAuth } from './fixtures/api.js';
import { ScriptedLlm, asked, say, use } from './fixtures/llm.js';

let h: Household;
let store: MemoryStore;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stub whose quote() fails the way the Instamart adapter did on 12 Oct, and whose search can be slowed or failed. */
class FlakySupplier extends StubSupplier {
  quoteError: string | undefined;
  searchDelayMs = 0;
  failQueries = new Set<string>();
  inflight = 0;
  maxInflight = 0;

  override async search(query: string, place: Place): Promise<SupplierProduct[]> {
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      if (this.searchDelayMs > 0) await sleep(this.searchDelayMs);
      if (this.failQueries.has(query)) throw new SupplierError(this.id, 'search', `no answer for ${query}`);
      return await super.search(query, place);
    } finally {
      this.inflight--;
    }
  }

  override async quote(lines: CartLine[], place: Place): Promise<Quote> {
    if (this.quoteError) throw new SupplierError(this.id, 'quote', this.quoteError);
    return super.quote(lines, place);
  }
}

let supplier: FlakySupplier;

beforeEach(() => {
  h = household();
  store = new MemoryStore([h]);
  supplier = new FlakySupplier({ now: () => NOW });
});

function req(text = 'biryani tonight, curd and dessert'): ShopRequest {
  return {
    id: `req_${Math.random().toString(36).slice(2)}`,
    householdId: h.id,
    memberId: owner(h).id,
    channel: 'web',
    receivedAt: NOW,
    text,
  };
}

function deps(llm: ScriptedLlm, extra: Partial<AgentDeps> = {}): AgentDeps {
  return { store, suppliers: [supplier], llm, now: () => NOW, model: 'test-model', ...extra };
}

const BILL = 'bill does not reconcile: items 41200 + fees 3200 != to-pay 47800 (paise); refusing to price this cart';
const milk = [asked('v-milk', 1, 'milk')];

describe('build_cart failures are fast, visible and honest', () => {
  it('the same build_cart error twice stops the loop with a deterministic summary', async () => {
    supplier.quoteError = BILL;
    const llm = new ScriptedLlm([
      [use('search_many', { queries: ['milk', 'rice'] })],
      [say('Let me build the cart now.'), use('build_cart', { lines: milk })],
      [say('Hmm, that failed. Let me try again with alternative rice:'), use('build_cart', { lines: milk })],
      [say('Good! Now let me try the cart again using alternative rice and this proper plain curd:')],
    ]);
    const { result, telemetry, toolCalls } = await runShopRequestDetailed(req(), deps(llm));

    expect(llm.calls).toBe(3); // the third turn's answer was never asked for
    expect(toolCalls).toBe(3);
    expect(telemetry.outcome).toBe('failed');
    expect(telemetry.abnormal).toBe('repeated_error');
    expect(result.quotes).toEqual([]);
    expect(result.summary).toMatch(
      /^For home: I couldn't build the cart — Instamart returned a bill I couldn't read \(.*bill does not reconcile.*\)\. Nothing was ordered\. Gate: not run — no cart was built\.$/,
    );
    expect(result.summary).not.toMatch(/alternative rice|Let me|Good!/);
    expect(supplier.placeCalls).toBe(0);
  });

  it('the model sees a structured error: { kind, message }', async () => {
    supplier.quoteError = BILL;
    const llm = new ScriptedLlm([
      [use('search_many', { queries: ['milk'] })],
      [use('build_cart', { lines: milk })],
      [use('build_cart', { lines: [asked('v-nope', 1)] })],
      [use('build_cart', { lines: [asked('v-nope', 1)] })],
    ]);
    await runShopRequestDetailed(req(), deps(llm));
    const supplierErr = llm.resultsAt(2)[0]!;
    expect(supplierErr.is_error).toBe(true);
    expect(supplierErr.body.error).toMatchObject({ kind: 'supplier' });
    expect((supplierErr.body.error as { message: string }).message).toContain('bill does not reconcile');
    const invalid = llm.resultsAt(3)[0]!;
    expect(invalid.body.error).toMatchObject({ kind: 'invalid_line' });
  });

  it('two different errors do not trip the repeat guard', async () => {
    supplier.quoteError = BILL;
    const llm = new ScriptedLlm([
      [use('search_many', { queries: ['milk'] })],
      [use('build_cart', { lines: [asked('v-nope', 1)] })], // invalid_line
      [use('build_cart', { lines: milk })], // supplier
      [say('Could not build the cart for home.')],
    ]);
    const { telemetry } = await runShopRequestDetailed(req(), deps(llm));
    expect(llm.calls).toBe(4);
    expect(telemetry.abnormal).toBeUndefined();
  });
});

describe('abnormal endings never leak narration', () => {
  it('budget exhaustion gives the deterministic summary', async () => {
    const llm = new ScriptedLlm([
      [use('search', { query: 'milk' }), use('search', { query: 'rice' }), use('search', { query: 'curd' })],
      [say('Now let me try the cart again using alternative rice:')],
    ]);
    const { result, telemetry } = await runShopRequestDetailed(req(), deps(llm, { maxToolCalls: 2 }));
    expect(telemetry.abnormal).toBe('budget');
    expect(telemetry.outcome).toBe('failed');
    expect(result.summary).toBe(
      "For home: I couldn't build the cart — I used all 2 tool calls without finishing. Nothing was ordered. Gate: not run — no cart was built.",
    );
  });

  it('wall time cuts a hanging tool and reports it', async () => {
    supplier.searchDelayMs = 400;
    const llm = new ScriptedLlm([[use('search_many', { queries: ['milk', 'rice'] })]]);
    const t0 = Date.now();
    const { result, telemetry } = await runShopRequestDetailed(req(), deps(llm, { maxWallMs: 100 }));
    expect(Date.now() - t0).toBeLessThan(350);
    expect(telemetry.abnormal).toBe('wall_time');
    expect(telemetry.toolCalls[0]).toMatchObject({ name: 'search_many', ok: false, errorKind: 'timeout' });
    expect(result.summary).toMatch(/^For home: I couldn't build the cart — .*Nothing was ordered\./);
  });

  it('a final message that ends with a colon is treated as abnormal, not shown', async () => {
    const llm = new ScriptedLlm([
      [use('search_many', { queries: ['milk'] })],
      [use('build_cart', { lines: milk })],
      [use('propose_checkout', {})],
      [say('Here is what I did for home:')],
    ]);
    const { result, telemetry } = await runShopRequestDetailed(req(), deps(llm));
    expect(telemetry.abnormal).toBe('no_final_text');
    expect(result.summary).not.toContain('Here is what I did');
    expect(result.summary).toMatch(/^For home: Cart of 1 item\(s\)/);
    expect(result.summary).toMatch(/Gate: /);
  });

  it('an LLM failure is reported without the provider error text', async () => {
    const llm = { create: () => Promise.reject(new Error('The model is deprecated, key sk-ant-SECRET123')) };
    const { result, telemetry } = await runShopRequestDetailed(req(), deps(llm as never));
    expect(telemetry.abnormal).toBe('llm_error');
    expect(result.summary).toMatch(/^For home: I couldn't build the cart — the assistant service did not answer\./);
    expect(JSON.stringify(result)).not.toContain('sk-ant');
  });

  it('on a normal finish trailing narration is stripped but the answer is kept', () => {
    expect(cleanFinalText('Cart for home, ₹412. Let me know if you want more. Now let me check the gate.').text).toBe(
      'Cart for home, ₹412. Let me know if you want more.',
    );
    expect(cleanFinalText('Let me look.').midPlan).toBe(true);
    expect(cleanFinalText('Plan:').midPlan).toBe(true);
    expect(cleanFinalText('').midPlan).toBe(false);
  });

  it('a built cart is not auto-submitted after an abnormal end', async () => {
    const llm = new ScriptedLlm([
      [use('search_many', { queries: ['milk'] })],
      [use('build_cart', { lines: milk })],
      [use('search', { query: 'rice' })],
    ]);
    const { result, telemetry } = await runShopRequestDetailed(req(), deps(llm, { maxToolCalls: 3 }));
    expect(telemetry.abnormal).toBe('budget');
    expect(supplier.placeCalls).toBe(0);
    expect(result.summary).toMatch(/priced but not submitted\. Nothing was ordered\./);
    expect(result.summary).toMatch(/Gate: not run/);
    expect(telemetry.outcome).toBe('quoted');
  });
});

describe('search_many and parallel tool use', () => {
  it('runs every query concurrently and reports a partial failure', async () => {
    supplier.searchDelayMs = 40;
    supplier.failQueries.add('curd');
    const llm = new ScriptedLlm([
      [use('search_many', { queries: ['milk', 'rice', 'onion', 'curd', 'chicken'] })],
      [say('Done for home.')],
    ]);
    const { toolCalls } = await runShopRequestDetailed(req(), deps(llm));
    expect(toolCalls).toBe(1);
    expect(supplier.maxInflight).toBe(5);

    const body = llm.resultsAt(1)[0]!.body as {
      ok: boolean;
      results: { query: string; products: { variants: { variantId: string }[] }[] }[];
      errors: { query: string; kind: string; message: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.results.map((r) => r.query)).toEqual(['milk', 'rice', 'onion', 'chicken']);
    expect(body.results.every((r) => r.products.length <= 5)).toBe(true);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({ query: 'curd', kind: 'supplier' });
  });

  it('variants from search_many can be used by build_cart; bad input is rejected', async () => {
    const llm = new ScriptedLlm([
      [
        use('search_many', { queries: [] }),
        use('search_many', { queries: Array.from({ length: 13 }, (_, i) => `q${i}`) }),
      ],
      [use('search_many', { queries: ['milk'] })],
      [use('build_cart', { lines: milk })],
      [use('propose_checkout', {})],
      [say('One milk for home.')],
    ]);
    const { result } = await runShopRequestDetailed(req(), deps(llm));
    expect(llm.resultsAt(1).map((r) => r.body.ok)).toEqual([false, false]);
    expect(result.chosen?.lines.map((l) => l.variantId)).toEqual(['v-milk']);
  });

  it('answers every tool_use block of a turn, in order, in one user message', async () => {
    const llm = new ScriptedLlm([
      [
        use('search', { query: 'milk' }),
        use('resolve_place'),
        use('read_cart', {}),
        use('search_many', { queries: ['rice'] }),
        use('build_cart', { lines: milk }), // runs after the read-only calls of the same turn
      ],
      [say('Priced for home.')],
    ]);
    const first = llm.requests.length;
    const { toolCalls, result } = await runShopRequestDetailed(req(), deps(llm));
    expect(first).toBe(0);
    expect(toolCalls).toBe(5);

    const assistant = llm.requests[1]!.messages.at(-2)!;
    const user = llm.requests[1]!.messages.at(-1)!;
    expect(assistant.role).toBe('assistant');
    expect(user.role).toBe('user');
    const ids = (assistant.content as { type: string; id?: string }[])
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.id);
    const answered = (user.content as { tool_use_id: string }[]).map((r) => r.tool_use_id);
    expect(answered).toEqual(ids);
    expect(llm.resultsAt(1).map((r) => r.body.ok)).toEqual([true, true, true, true, true]);
    expect(result.quotes).toHaveLength(1);
  });

  it('calls past the budget in a parallel turn get an error result, not silence', async () => {
    const llm = new ScriptedLlm([
      [use('search', { query: 'a' }), use('search', { query: 'b' }), use('search', { query: 'c' })],
      [say('Stopped for home.')],
    ]);
    await runShopRequestDetailed(req(), deps(llm, { maxToolCalls: 2 }));
    expect(llm.resultsAt(1).map((r) => !!r.is_error)).toEqual([false, false, true]);
  });
});

describe('trace', () => {
  it('records name, ms, ok and error kind per call, with usage when reported', async () => {
    supplier.quoteError = BILL;
    const llm = new ScriptedLlm([
      [use('search_many', { queries: ['milk'] })],
      [use('build_cart', { lines: milk })],
      [say('Could not build the cart for home.')],
    ]);
    const withUsage = {
      calls: 0,
      async create(r: Parameters<ScriptedLlm['create']>[0]) {
        const res = await llm.create(r);
        return { ...res, usage: { input_tokens: 100, output_tokens: 10 } };
      },
    };
    const { telemetry } = await runShopRequestDetailed(req(), deps(withUsage as never));
    expect(telemetry.model).toBe('test-model');
    expect(telemetry.usage).toEqual({ inputTokens: 300, outputTokens: 30, llmCalls: 3 });
    expect(telemetry.toolCalls.map((t) => [t.name, t.ok, t.errorKind])).toEqual([
      ['search_many', true, undefined],
      ['build_cart', false, 'supplier'],
    ]);
    expect(telemetry.toolCalls.every((t) => typeof t.ms === 'number')).toBe(true);
  });

  it('the logged line and the debug field carry no tokens, keys, phones or addresses', async () => {
    const home = placeNamed(h, 'home');
    const phone = owner(h).channels[0]!.address; // +910000000001
    supplier.quoteError = `bad bill for ${home.canonicalAddress}; call ${phone} or 98765 43210; Bearer mtk_ABCDEF123456 sk-ant-api03-ZZZ ${'x'.repeat(400)}`;
    const lines: string[] = [];
    const app = buildServer(
      {
        store,
        suppliers: [supplier],
        llm: new ScriptedLlm([
          [use('search_many', { queries: ['milk'] })],
          [use('build_cart', { lines: milk })],
          [use('build_cart', { lines: milk })],
        ]),
        apiToken: 'test-token',
        defaultHouseholdId: h.id,
        now: () => NOW,
        model: 'test-model',
      },
      { logStream: { write: (m) => void lines.push(m) } },
    );
    const auth = await memberAuth(store, owner(h));
    const token = auth.authorization!.replace('Bearer ', '');

    const plain = await app.inject({ method: 'POST', url: '/request', payload: { text: 'milk' }, headers: auth });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().debug).toBeUndefined();
    expect(plain.json().summary).toMatch(/Nothing was ordered/);

    // Second request, with debug: its llm script is spent, so it ends with "Done." and no cart.
    const dbg = await app.inject({
      method: 'POST',
      url: '/request',
      payload: { text: 'milk' },
      headers: { ...auth, 'x-bazaar-debug': '1' },
    });
    const debug = dbg.json().debug as { trace: Record<string, unknown>[]; outcome: string };
    expect(debug.trace.length).toBeGreaterThanOrEqual(0);
    expect(debug.outcome).toBe('failed');

    const traceLines = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === 'shop_request');
    expect(traceLines).toHaveLength(2);
    const first = traceLines[0]!;
    expect(first).toMatchObject({ level: 30, model: 'test-model', outcome: 'failed' });
    expect(first.requestId).toBeTruthy();
    expect(first.placeId).toBe(home.id);
    expect(typeof first.totalMs).toBe('number');
    const calls = first.toolCalls as {
      name: string;
      ms: number;
      ok: boolean;
      errorKind?: string;
      errorMessage?: string;
    }[];
    expect(calls.map((c) => c.name)).toEqual(['search_many', 'build_cart', 'build_cart']);
    expect(calls[1]!.errorKind).toBe('supplier');
    expect(calls[1]!.errorMessage!.length).toBeLessThanOrEqual(300);

    const everything = lines.join('\n') + JSON.stringify(plain.json()) + JSON.stringify(dbg.json());
    for (const secret of [token, 'mtk_ABCDEF123456', 'sk-ant-api03', phone, '98765 43210', home.canonicalAddress]) {
      expect(everything, secret).not.toContain(secret);
    }
    await app.close();
  });

  it('debug trace on a request that builds a cart lists tools without arguments', async () => {
    const app = buildServer({
      store,
      suppliers: [supplier],
      llm: new ScriptedLlm([
        [use('search_many', { queries: ['milk'] })],
        [use('build_cart', { lines: milk })],
        [use('propose_checkout', {})],
        [say('One milk for home.')],
      ]),
      apiToken: 'test-token',
      defaultHouseholdId: h.id,
      now: () => NOW,
      model: 'test-model',
    });
    const auth = await memberAuth(store, owner(h));
    const res = await app.inject({
      method: 'POST',
      url: '/request',
      payload: { text: 'milk' },
      headers: { ...auth, 'x-bazaar-debug': '1' },
    });
    const body = res.json();
    expect(body.debug.outcome).toBe('paid');
    expect(body.debug.trace.map((t: { name: string }) => t.name)).toEqual([
      'search_many',
      'build_cart',
      'propose_checkout',
    ]);
    expect(JSON.stringify(body.debug)).not.toContain('v-milk');
    await app.close();
  });
});
