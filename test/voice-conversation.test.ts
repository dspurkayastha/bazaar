/** runConversationTurn and the voice approval rules, without sockets. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkVoiceApproval,
  runConversationTurn,
  type ConversationDeps,
  type PendingConfirmation,
  type VoiceDecision,
} from '../src/agent/conversation.js';
import { MemoryStore } from '../src/agent/memory-store.js';
import { approveQuote } from '../src/api/routes/approve.js';
import type { Household } from '../src/core/types.js';
import { StubSupplier } from '../src/suppliers/stub/index.js';
import { ConversationSession, SessionRegistry, canTransition } from '../src/voice/session.js';
import { NOW, adder, household, owner } from './fixtures/context.js';
import { ScriptedLlm, asked, say, use, type Step } from './fixtures/llm.js';

let h: Household;
let store: MemoryStore;
let supplier: StubSupplier;
let clock: number;

beforeEach(() => {
  h = household();
  store = new MemoryStore([h]);
  supplier = new StubSupplier({ now: () => NOW });
  clock = 1_000_000;
});

const cart1123 = [asked('v-milk', 2, 'milk'), asked('v-rice', 1), asked('v-chicken', 2), asked('v-onion-1kg', 4)];
const held: Step[] = [
  [use('search_many', { queries: ['milk', 'rice', 'chicken', 'onion'] })],
  [use('build_cart', { lines: cart1123 })],
  [use('propose_checkout', {})],
  [say('Egaroshō teish taka. Order kori?')],
];

function deps(llm: ScriptedLlm, over: Partial<ConversationDeps> = {}): ConversationDeps {
  const base = {
    store,
    suppliers: [supplier],
    llm,
    now: () => NOW,
    model: 'test-model',
    apiToken: 'test-token',
    defaultHouseholdId: h.id,
    // These tests exercise the spoken-yes rules on a ₹1,123 cart, so the PIN threshold is ₹2,000 unless a test
    // says otherwise; the approval service and the voice rule always share one threshold.
    pinRequiredAbovePaise: over.pinRequiredAbovePaise ?? 200_000,
  };
  return {
    ...base,
    approve: (hash, who) => approveQuote(base, hash, who),
    clock: () => clock,
    ...over,
  };
}

function session(memberId = owner(h).id): ConversationSession {
  const s = new ConversationSession(h.id, memberId, clock, 600_000);
  s.attach(clock);
  return s;
}

const confirmWith =
  (hash: string | (() => string)): Step =>
  () => [use('confirm_pending_order', { quoteHash: typeof hash === 'string' ? hash : hash() })];

/** Turn 1 holds the ₹1,123 cart; returns the pending confirmation. */
async function holdCart(
  s: ConversationSession,
  llm: ScriptedLlm,
  d: ConversationDeps,
  decisions: VoiceDecision[] = [],
) {
  const r = await runConversationTurn(s, 'biryani-r jinish pathao', 'bn-IN', d, {
    onDecision: (x) => decisions.push(x),
  });
  expect(r.outcome).toBe('held');
  return s.pending!;
}

describe('voice approvals (server-enforced)', () => {
  it('owner, same connection, exact hash, within 90 s and under the limit → approval + gate places', async () => {
    const ref: { p?: PendingConfirmation } = {};
    const llm = new ScriptedLlm([...held, confirmWith(() => ref.p!.quoteHash), [say('Order hoye geche.')]]);
    const d = deps(llm);
    const s = session();
    ref.p = await holdCart(s, llm, d);
    const p = ref.p;
    expect(p).toMatchObject({ total: 112300, needsPin: false });
    clock += 89_000;
    const r = await runConversationTurn(s, 'hyan, order koro', 'bn-IN', d);
    expect(r.outcome).toBe('paid');
    expect(llm.resultsAt(5)[0]!.body).toMatchObject({ ok: true, status: 'PLACED', total: 112300 });
    expect(supplier.placed).toHaveLength(1);
    expect(supplier.placed[0]!.quote.hash).toBe(p.quoteHash);
    // Went through the /approve path: an owner Approval on that hash exists and was consumed.
    const approvals = store.approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ quoteHash: p.quoteHash, memberId: owner(h).id });
    expect(approvals[0]!.consumedAt).toBeDefined();
    expect(s.pending).toBeUndefined();
  });

  it('90 s or more after the question → refused (too_late), nothing placed, question re-armed', async () => {
    const ref: { p?: PendingConfirmation } = {};
    const llm = new ScriptedLlm([
      ...held,
      confirmWith(() => ref.p!.quoteHash),
      [say('Abar bolchi: egaroshō teish taka. Order kori?')],
    ]);
    const d = deps(llm);
    const s = session();
    ref.p = await holdCart(s, llm, d);
    const p = ref.p;
    clock += 90_000;
    await runConversationTurn(s, 'hyan', 'bn-IN', d);
    expect(llm.resultsAt(5)[0]!.body).toMatchObject({ ok: false, refused: 'too_late' });
    expect(supplier.placed).toHaveLength(0);
    expect(s.pending?.quoteHash).toBe(p.quoteHash);
    expect(s.pending?.askedAt).toBe(clock);
  });

  it('a different hash → refused (wrong_quote)', async () => {
    const llm = new ScriptedLlm([...held, confirmWith('a'.repeat(64)), [say('Thik ache.')]]);
    const d = deps(llm);
    const s = session();
    await holdCart(s, llm, d);
    await runConversationTurn(s, 'hyan', 'bn-IN', d);
    expect(llm.resultsAt(5)[0]!.body).toMatchObject({ ok: false, refused: 'wrong_quote' });
    expect(supplier.placed).toHaveLength(0);
  });

  it('over the PIN threshold → needsPin (decision sent), a spoken yes never approves', async () => {
    const ref: { p?: PendingConfirmation } = {};
    const decisions: VoiceDecision[] = [];
    const llm = new ScriptedLlm([...held, confirmWith(() => ref.p!.quoteHash), [say('PIN diye approve korun.')]]);
    const d = deps(llm, { pinRequiredAbovePaise: 100_000 });
    const s = session();
    ref.p = await holdCart(s, llm, d, decisions);
    const p = ref.p;
    expect(decisions[0]).toMatchObject({ verdict: 'HOLD', needsPin: true, spokenConfirmation: false });
    expect(p.needsPin).toBe(true);
    await runConversationTurn(s, 'hyan', 'bn-IN', d, { onDecision: (x) => decisions.push(x) });
    expect(llm.resultsAt(5)[0]!.body).toMatchObject({ ok: false, needsPin: true, refused: 'needs_pin' });
    expect(decisions[1]).toMatchObject({ needsPin: true, quoteHash: p.quoteHash });
    expect(supplier.placed).toHaveLength(0);
  });

  it('the limit is exact paise: total == limit passes, limit - 1 paisa needs the PIN', () => {
    const pending: PendingConfirmation = {
      quoteHash: 'h',
      total: 200_000,
      supplierId: 'instamart',
      placeId: 'p',
      reasons: [],
      askedAt: 0,
      needsPin: false,
    };
    const base = {
      member: { role: 'owner' as const },
      authenticated: true,
      pending,
      quoteHash: 'h',
      now: 1,
      windowMs: 90_000,
    };
    expect(checkVoiceApproval({ ...base, maxPaise: 200_000 })).toEqual({ ok: true });
    expect(checkVoiceApproval({ ...base, maxPaise: 199_999 })).toEqual({ ok: false, reason: 'needs_pin' });
    expect(checkVoiceApproval({ ...base, maxPaise: 200_000, now: 89_999 }).ok).toBe(true);
    expect(checkVoiceApproval({ ...base, maxPaise: 200_000, now: 90_000 })).toEqual({ ok: false, reason: 'too_late' });
    expect(checkVoiceApproval({ ...base, maxPaise: 200_000, authenticated: false }).reason).toBe('unauthenticated');
    expect(checkVoiceApproval({ ...base, maxPaise: 200_000, member: { role: 'adder' } }).reason).toBe('owner_required');
    expect(checkVoiceApproval({ ...base, maxPaise: 200_000, pending: undefined }).reason).toBe('nothing_pending');
  });

  it('an adder’s yes is ignored for payment: no pending is created and confirm is refused', async () => {
    const llm = new ScriptedLlm([...held, confirmWith('b'.repeat(64)), [say('Owner approve korbe.')]]);
    const d = deps(llm);
    const s = session(adder(h).id);
    const decisions: VoiceDecision[] = [];
    await runConversationTurn(s, 'pathao', 'bn-IN', d, { onDecision: (x) => decisions.push(x) });
    expect(decisions[0]).toMatchObject({ verdict: 'HOLD', needsPin: false, spokenConfirmation: false });
    expect(s.pending).toBeUndefined();
    await runConversationTurn(s, 'haan', 'bn-IN', d);
    expect(llm.resultsAt(5)[0]!.body).toMatchObject({ ok: false, refused: 'owner_required' });
    expect(supplier.placed).toHaveLength(0);
  });

  it('a session that is not on an authenticated connection cannot approve', async () => {
    const ref: { p?: PendingConfirmation } = {};
    const llm = new ScriptedLlm([...held, confirmWith(() => ref.p!.quoteHash), [say('Na.')]]);
    const d = deps(llm);
    const s = session();
    ref.p = await holdCart(s, llm, d);
    s.authenticated = false;
    await runConversationTurn(s, 'hyan', 'bn-IN', d);
    expect(llm.resultsAt(5)[0]!.body).toMatchObject({ ok: false, refused: 'unauthenticated' });
    expect(supplier.placed).toHaveLength(0);
  });

  it('the yes must come in the very next turn', async () => {
    const ref: { p?: PendingConfirmation } = {};
    const llm = new ScriptedLlm([...held, [say('Ar kichu?')], confirmWith(() => ref.p!.quoteHash), [say('Na.')]]);
    const d = deps(llm);
    const s = session();
    ref.p = await holdCart(s, llm, d);
    await runConversationTurn(s, 'ek minute', 'bn-IN', d);
    expect(s.pending).toBeUndefined();
    await runConversationTurn(s, 'hyan', 'bn-IN', d);
    expect(llm.resultsAt(6)[0]!.body).toMatchObject({ ok: false, refused: 'nothing_pending' });
    expect(supplier.placed).toHaveLength(0);
  });

  it('BLOCK is never approvable: nothing is pending, a yes is refused', async () => {
    const llm = new ScriptedLlm([
      [use('search', { query: 'cooker' })],
      [use('build_cart', { lines: [asked('v-cooker', 1)] })],
      [use('propose_checkout', {})],
      [say('Cooker app theke kinte hobe.')],
      (req) => [use('confirm_pending_order', { quoteHash: /[0-9a-f]{64}/.exec(JSON.stringify(req.messages))![0] })],
      [say('Hobe na.')],
    ]);
    const d = deps(llm, { pinRequiredAbovePaise: 10_000_000 });
    const s = session();
    const decisions: VoiceDecision[] = [];
    const r = await runConversationTurn(s, 'pressure cooker pathao', 'en-IN', d, {
      onDecision: (x) => decisions.push(x),
    });
    expect(r.outcome).toBe('blocked');
    expect(decisions[0]).toMatchObject({ verdict: 'BLOCK', needsPin: false, spokenConfirmation: false });
    expect(s.pending).toBeUndefined();
    await runConversationTurn(s, 'yes', 'en-IN', d);
    expect(llm.resultsAt(5)[0]!.body).toMatchObject({ ok: false, refused: 'nothing_pending' });
    expect(supplier.placed).toHaveLength(0);
  });

  it('within unattended limits the gate places on propose (PAY) and the app gets the order', async () => {
    const orders: unknown[] = [];
    const llm = new ScriptedLlm([
      [use('search_many', { queries: ['milk', 'rice', 'onion'] })],
      [use('build_cart', { lines: [asked('v-milk', 1), asked('v-rice', 1), asked('v-onion-1kg', 2)] })],
      [use('propose_checkout', {})],
      [say('Order hoye geche, char sho baro taka.')],
    ]);
    const s = session();
    const r = await runConversationTurn(s, 'dudh chal pyaj', 'bn-IN', deps(llm), { onOrder: (o) => orders.push(o) });
    expect(r.outcome).toBe('paid');
    expect(orders).toHaveLength(1);
    expect(s.pending).toBeUndefined();
  });
});

describe('conversation mechanics', () => {
  it('a barge-in during a tool call lets the tool finish, records it, and makes no further model call', async () => {
    const abort = new AbortController();
    // search first (in the same model turn) so v-milk has been shown.
    const steps = new ScriptedLlm([
      [use('search', { query: 'milk' }), use('build_cart', { lines: [asked('v-milk', 1)] })],
      [say('never')],
    ]);
    const s = session();
    const r = await runConversationTurn(s, 'dudh', 'bn-IN', deps(steps), {
      signal: abort.signal,
      onToolStart: (name) => {
        if (name === 'build_cart') abort.abort();
      },
    });
    expect(r.aborted).toBe(true);
    expect(r.outcome).toBe('interrupted');
    expect(steps.calls).toBe(1);
    expect(r.toolCalls.map((t) => [t.name, t.ok])).toEqual([
      ['search', true],
      ['build_cart', true],
    ]);
    // History: user, assistant(tool_use), user(tool_results), assistant(closing note).
    expect(s.turns[0]!.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(s.pending).toBeUndefined();
  });

  it('non-streaming clients still deliver the reply through onText', async () => {
    const llm = new ScriptedLlm([[say('Nomoskar.')]]);
    const deltas: string[] = [];
    const r = await runConversationTurn(session(), 'hello', 'bn-IN', deps(llm), { onText: (d) => deltas.push(d) });
    expect(r).toMatchObject({ text: 'Nomoskar.', byCode: false, outcome: 'replied' });
    expect(deltas.join('')).toContain('Nomoskar.');
  });

  it('a failed model call ends the turn with a code-written reply in the turn language', async () => {
    const llm = { create: async () => Promise.reject(new Error('boom')) };
    const r = await runConversationTurn(session(), 'hello', 'hi-IN', deps(llm as unknown as ScriptedLlm));
    expect(r).toMatchObject({ byCode: true, outcome: 'failed' });
    expect(r.text).toContain('ऑर्डर नहीं हुआ');
  });

  it('caps history at maxTurns', async () => {
    const llm = new ScriptedLlm(Array.from({ length: 5 }, (_, i) => [say(`Reply ${i}.`)]));
    const s = session();
    const d = deps(llm, { maxTurns: 3 });
    for (let i = 0; i < 5; i++) await runConversationTurn(s, `turn ${i}`, 'en-IN', d);
    expect(s.turns).toHaveLength(3);
    expect(JSON.stringify(s.turns[0])).toContain('turn 2');
    expect(llm.requests[4]!.messages).toHaveLength(3 * 2 + 1);
  });

  it('uses the voice system prompt in the turn language', async () => {
    const llm = new ScriptedLlm([[say('Thik.')]]);
    await runConversationTurn(session(), 'kichu na', 'bn-IN', deps(llm));
    const sys = llm.requests[0]!.system;
    expect(sys).toContain('## Voice mode');
    expect(sys).toContain("This turn's reply language: bn-IN");
    expect(sys).toContain('₹2,000');
  });
});

describe('ConversationSession', () => {
  it('drops history after 10 minutes idle (TTL) and starts fresh from the registry', () => {
    const reg = new SessionRegistry(600_000);
    const s = reg.get(h.id, owner(h).id, 0);
    s.turns.push([{ role: 'user', content: 'x' }]);
    s.placeId = 'pl_x';
    expect(reg.get(h.id, owner(h).id, 599_999)).toBe(s);
    expect(s.refresh(599_999)).toBe(false);
    expect(s.turns).toHaveLength(1);
    // 10 minutes after the last activity: a reconnect gets a new session; a live one resets on its next turn.
    const fresh = reg.get(h.id, owner(h).id, 599_999 + 600_000);
    expect(fresh).not.toBe(s);
    expect(fresh.turns).toHaveLength(0);
    expect(s.refresh(599_999 + 600_000)).toBe(true);
    expect(s.turns).toHaveLength(0);
    expect(s.placeId).toBeUndefined();
  });

  it('enforces the state machine', () => {
    const s = new ConversationSession(h.id, owner(h).id, 0, 1000);
    expect(() => s.transition('speaking')).toThrow(/illegal/);
    s.transition('listening');
    s.transition('thinking');
    s.transition('speaking');
    s.transition('awaiting_confirmation');
    expect(() => s.transition('speaking')).toThrow(/illegal/);
    s.transition('thinking');
    expect(canTransition('idle', 'thinking')).toBe(false);
  });

  it('a new connection clears any pending confirmation', () => {
    const s = new ConversationSession(h.id, owner(h).id, 0, 1000);
    s.pending = {
      quoteHash: 'h',
      total: 1,
      supplierId: 'instamart',
      placeId: 'p',
      reasons: [],
      askedAt: 0,
      needsPin: false,
    };
    s.attach(1);
    expect(s.pending).toBeUndefined();
    expect(s.authenticated).toBe(true);
    s.detach(2);
    expect(s.authenticated).toBe(false);
  });
});
