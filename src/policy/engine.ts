/**
 * The policy engine: a pure, synchronous function from PolicyContext to PAY / HOLD / BLOCK.
 * No I/O, no clock (time comes from ctx.now), no randomness. Rules and defaults: PRD "Policy engine" table.
 *
 * Every rule is evaluated (no short-circuit) so `reasons` lists every breach.
 * Verdict = BLOCK if any BLOCK rule fires; else HOLD if any HOLD rule fires and no valid owner approval
 * covers the quote hash; else PAY. A valid approval turns HOLD into PAY but never overrides BLOCK.
 * Content rules (amounts, categories, quantities) are evaluated on the union of the quote and the live cart,
 * so nothing that will actually be paid escapes them.
 */
import { quoteHash } from '../core/hash.js';
import { formatINR } from '../core/money.js';
import type { Approval, PolicyContext, PolicyDecision, PolicyVerdict, QuoteLine } from '../core/types.js';

export const RULES = {
  quoteMismatch: 'quote_mismatch',
  perOrderCeiling: 'per_order_ceiling',
  dailyCap: 'daily_cap',
  monthlyCap: 'monthly_cap',
  categoryUnattended: 'category_unattended',
  categoryBlocked: 'category_blocked',
  unitPriceBlocked: 'unit_price_blocked',
  quantityBound: 'quantity_bound',
  role: 'role',
  placeUntrusted: 'place_untrusted',
  approvalMismatch: 'approval_mismatch',
  approvalExpired: 'approval_expired',
  scheduledConditions: 'scheduled_conditions',
} as const;

export type RuleName = (typeof RULES)[keyof typeof RULES];

type Severity = Exclude<PolicyVerdict, 'PAY'>;
interface Breach {
  rule: RuleName;
  detail: string;
  severity: Severity;
}

type ApprovalStatus =
  | { kind: 'valid' }
  | { kind: 'other_hash' }
  | { kind: 'not_owner' }
  | { kind: 'expired' }
  | { kind: 'conditions_failed'; detail: string };

function time(iso: string, label: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new TypeError(`${label} is not an ISO date-time: ${iso}`);
  return t;
}

/** The profile item key a supplier line belongs to (via learned supplier hints), else the variant id. */
export function itemKeyForLine(ctx: PolicyContext, line: Pick<QuoteLine, 'variantId' | 'skuId'>): string {
  const supplierId = ctx.quote.supplierId;
  for (const d of ctx.household.profile.defaults) {
    const hint = d.supplierHints?.[supplierId];
    if (!hint) continue;
    if (hint.spinId === line.variantId || (line.skuId !== undefined && hint.skuId === line.skuId)) return d.key;
  }
  return line.variantId;
}

function classifyApproval(ctx: PolicyContext, a: Approval, nowMs: number): ApprovalStatus {
  if (a.quoteHash !== ctx.quote.hash || a.quoteHash !== ctx.liveCart.hash) return { kind: 'other_hash' };
  const member = ctx.household.members.find((m) => m.id === a.memberId);
  if (!member || member.role !== 'owner') return { kind: 'not_owner' };
  if (nowMs >= time(a.expiresAt, 'approval.expiresAt') || nowMs < time(a.createdAt, 'approval.createdAt')) {
    return { kind: 'expired' };
  }
  const c = a.conditions;
  if (c) {
    const failed: string[] = [];
    if (c.notBefore !== undefined && nowMs < time(c.notBefore, 'conditions.notBefore')) {
      failed.push(`not before ${c.notBefore}`);
    }
    if (c.maxTotal !== undefined && ctx.liveCart.total > c.maxTotal) {
      failed.push(`total ${formatINR(ctx.liveCart.total)} > approved max ${formatINR(c.maxTotal)}`);
    }
    if (c.inStock && (ctx.liveCart.unavailable.length > 0 || ctx.quote.unavailable.length > 0)) {
      const keys = [...ctx.quote.unavailable, ...ctx.liveCart.unavailable].map((u) => u.itemKey);
      failed.push(`items unavailable: ${[...new Set(keys)].join(', ')}`);
    }
    if (failed.length > 0) return { kind: 'conditions_failed', detail: failed.join('; ') };
  }
  return { kind: 'valid' };
}

export function decide(ctx: PolicyContext): PolicyDecision {
  const { household, place, quote, liveCart, requestingMember } = ctx;
  const policy = household.policy;
  const nowMs = time(ctx.now, 'ctx.now');
  const breaches: Breach[] = [];
  const hold = (rule: RuleName, detail: string) => breaches.push({ rule, detail, severity: 'HOLD' });
  const block = (rule: RuleName, detail: string) => breaches.push({ rule, detail, severity: 'BLOCK' });

  // --- Quote integrity (BLOCK, re-quote) ---
  if (liveCart.hash !== quote.hash) {
    block(RULES.quoteMismatch, `live cart hash ${liveCart.hash.slice(0, 12)} ≠ quote hash ${quote.hash.slice(0, 12)}`);
  }
  if (liveCart.total !== quote.total) {
    block(RULES.quoteMismatch, `live cart total ${formatINR(liveCart.total)} ≠ quoted ${formatINR(quote.total)}`);
  }
  if (quoteHash(quote) !== quote.hash) block(RULES.quoteMismatch, 'quote hash does not match its contents');
  if (quoteHash(liveCart) !== liveCart.hash) block(RULES.quoteMismatch, 'live cart hash does not match its contents');
  if (quote.placeId !== place.id || liveCart.placeId !== place.id) {
    block(RULES.quoteMismatch, `quote is for place ${quote.placeId}, not ${place.nickname} (${place.id})`);
  }
  const expectedAddress = place.supplierAddressIds[quote.supplierId];
  if (expectedAddress !== quote.supplierAddressId || liveCart.supplierAddressId !== quote.supplierAddressId) {
    block(RULES.quoteMismatch, `supplier address ${liveCart.supplierAddressId} is not ${place.nickname}'s`);
  }
  if (liveCart.supplierId !== quote.supplierId) {
    block(RULES.quoteMismatch, `supplier ${liveCart.supplierId} ≠ ${quote.supplierId}`);
  }

  // --- Amounts (HOLD) ---
  const total = Math.max(quote.total, liveCart.total);
  if (total > policy.perOrderUnattendedMax) {
    hold(
      RULES.perOrderCeiling,
      `${formatINR(total)} > per-order unattended max ${formatINR(policy.perOrderUnattendedMax)}`,
    );
  }
  if (ctx.spendToday + total > policy.dailyUnattendedMax) {
    hold(
      RULES.dailyCap,
      `today ${formatINR(ctx.spendToday)} + ${formatINR(total)} > daily max ${formatINR(policy.dailyUnattendedMax)}`,
    );
  }
  if (ctx.spendThisMonth + total > policy.monthlyMax) {
    hold(
      RULES.monthlyCap,
      `this month ${formatINR(ctx.spendThisMonth)} + ${formatINR(total)} > monthly max ${formatINR(policy.monthlyMax)}`,
    );
  }

  // --- Lines: categories, unit price, quantity (union of quote and live cart) ---
  const lines = new Map<string, QuoteLine>();
  for (const l of [...quote.lines, ...liveCart.lines]) {
    const k = `${l.variantId}|${l.category}|${l.quantity}|${l.unitPrice}`;
    if (!lines.has(k)) lines.set(k, l);
  }
  const blocked = new Set(policy.blockedCategories);
  const unattended = new Set(policy.unattendedCategories);
  for (const l of lines.values()) {
    if (blocked.has(l.category)) {
      block(RULES.categoryBlocked, `${l.name} is ${l.category}; owner must buy in the app`);
    } else if (!unattended.has(l.category)) {
      hold(RULES.categoryUnattended, `${l.name} is ${l.category}, not allowed unattended`);
    }
    if (l.unitPrice > policy.blockedUnitPriceOver) {
      block(
        RULES.unitPriceBlocked,
        `${l.name} at ${formatINR(l.unitPrice)} per unit > ${formatINR(policy.blockedUnitPriceOver)}`,
      );
    }
    const key = itemKeyForLine(ctx, l);
    const maxSeen = ctx.quantityHistory[key] ?? ctx.quantityHistory[l.variantId];
    if (maxSeen !== undefined) {
      const bound = maxSeen * policy.quantityBoundMultiplier;
      if (l.quantity > bound) {
        hold(
          RULES.quantityBound,
          `${l.name} × ${l.quantity} > ${policy.quantityBoundMultiplier} × 90-day max ${maxSeen} for ${key}`,
        );
      }
    }
  }

  // --- Who and where ---
  if (requestingMember.householdId !== household.id) {
    block(RULES.role, `${requestingMember.name} is not a member of ${household.name}`);
  } else if (requestingMember.role !== 'owner') {
    hold(RULES.role, `${requestingMember.name} is ${requestingMember.role}; only an owner can pay`);
  }
  if (place.householdId !== household.id) {
    block(RULES.placeUntrusted, `${place.nickname} is not a place of ${household.name}`);
  } else if (!place.trusted) {
    hold(RULES.placeUntrusted, `${place.nickname} is not trusted for unattended pay`);
  }

  // --- Approvals ---
  const statuses = ctx.approvals.map((a) => ({ a, s: classifyApproval(ctx, a, nowMs) }));
  // An owner's conditions on this exact hash are binding: if they fail, hold, never substitute.
  for (const { a, s } of statuses) {
    if (s.kind === 'conditions_failed') hold(RULES.scheduledConditions, `approval ${a.id}: ${s.detail}`);
  }
  const valid = statuses.find((x) => x.s.kind === 'valid')?.a;

  const anyBlock = breaches.some((b) => b.severity === 'BLOCK');
  const anyHold = breaches.some((b) => b.severity === 'HOLD');

  if (!anyBlock && anyHold && !valid) {
    // Explain why no approval lifted the hold.
    if (statuses.length > 0 && statuses.every((x) => x.s.kind === 'other_hash')) {
      hold(RULES.approvalMismatch, `no approval is bound to quote hash ${quote.hash.slice(0, 12)}`);
    }
    for (const { a, s } of statuses) {
      if (s.kind === 'expired') hold(RULES.approvalExpired, `approval ${a.id} expired at ${a.expiresAt}`);
      if (s.kind === 'not_owner') hold(RULES.role, `approval ${a.id} is not from an owner`);
    }
  }

  const verdict: PolicyVerdict = anyBlock ? 'BLOCK' : anyHold && !valid ? 'HOLD' : 'PAY';
  return {
    verdict,
    reasons: breaches.map(({ rule, detail }) => ({ rule, detail })),
    ...(verdict === 'PAY' && anyHold && valid ? { approvalId: valid.id } : {}),
    evaluatedAt: ctx.now,
  };
}
