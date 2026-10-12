import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/agent/memory-store.js';
import { issueMemberToken } from '../src/api/auth.js';
import {
  hashMemberToken,
  looksLikeMemberToken,
  newMemberToken,
  verifyWebhookSignature,
  webhookSignature,
} from '../src/core/credentials.js';
import { decide } from '../src/policy/engine.js';
import {
  adder,
  approval,
  ctx,
  groceryCart1123,
  groceryCart412,
  household,
  owner,
  placeNamed,
} from './fixtures/context.js';

const rules = (d: { reasons: { rule: string }[] }) => d.reasons.map((r) => r.rule);

describe('member tokens', () => {
  it('are random mtk_ tokens; only the sha256 is stored, and issuing again rotates', async () => {
    const t = newMemberToken();
    expect(looksLikeMemberToken(t)).toBe(true);
    expect(newMemberToken()).not.toBe(t);
    expect(hashMemberToken(t)).toMatch(/^[0-9a-f]{64}$/);

    const h = household();
    const store = new MemoryStore([h]);
    const first = await issueMemberToken(store, owner(h).id);
    expect([...store.credentials.keys()]).toEqual([hashMemberToken(first)]);
    expect(JSON.stringify([...store.credentials])).not.toContain(first);
    expect(await store.findMemberByTokenHash(hashMemberToken(first))).toEqual({
      householdId: h.id,
      memberId: owner(h).id,
    });
    const second = await issueMemberToken(store, owner(h).id);
    expect(await store.findMemberByTokenHash(hashMemberToken(first))).toBeUndefined();
    expect((await store.findMemberByTokenHash(hashMemberToken(second)))?.memberId).toBe(owner(h).id);
    await expect(issueMemberToken(store, 'mem_nobody')).rejects.toThrow();
  });
});

describe('webhook signatures', () => {
  const body = Buffer.from('{"from":"+910000000001","body":"milk"}');
  it('verifies HMAC-SHA256 over the exact raw bytes, in constant time', () => {
    const sig = webhookSignature('s3cret', body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature('s3cret', body, sig)).toBe(true);
    expect(verifyWebhookSignature('other', body, sig)).toBe(false);
    expect(verifyWebhookSignature('s3cret', Buffer.from(`${body.toString()} `), sig)).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, sig.toUpperCase())).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, sig.slice(7))).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, undefined)).toBe(false);
    expect(verifyWebhookSignature('', body, webhookSignature('', body))).toBe(false);
  });
});

describe('engine: webhook-originated requests', () => {
  const h = household();
  const home = placeNamed(h, 'home');

  it('an untrusted channel HOLDs even an owner on a ₹412 cart that would otherwise PAY', () => {
    const q = groceryCart412(home);
    expect(decide(ctx({ household: h, place: home, quote: q })).verdict).toBe('PAY');
    const d = decide(ctx({ household: h, place: home, quote: q, webhook: { channel: 'whatsapp', trusted: false } }));
    expect(d.verdict).toBe('HOLD');
    expect(rules(d)).toEqual(['channel_untrusted']);
  });

  it('a trusted owner channel gets the normal policy; an adder still HOLDs on role', () => {
    const q = groceryCart412(home);
    const trusted = { channel: 'whatsapp' as const, trusted: true };
    expect(decide(ctx({ household: h, place: home, quote: q, webhook: trusted })).verdict).toBe('PAY');
    const d = decide(ctx({ household: h, place: home, quote: q, webhook: trusted, requestingMember: adder(h) }));
    expect(rules(d)).toEqual(['role']);
  });

  it('approvals never apply to a webhook request, even a valid owner approval on the exact hash', () => {
    const q = groceryCart1123(home);
    const a = approval(h, q.hash);
    expect(decide(ctx({ household: h, place: home, quote: q, approvals: [a] })).verdict).toBe('PAY');
    const d = decide(
      ctx({ household: h, place: home, quote: q, approvals: [a], webhook: { channel: 'whatsapp', trusted: true } }),
    );
    expect(d.verdict).toBe('HOLD');
    expect(d.approvalId).toBeUndefined();
  });
});
