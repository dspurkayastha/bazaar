/**
 * In-memory Store: the reference implementation for tests and for running the API without Postgres.
 * Its recorder mirrors DbDecisionRecorder: appends decisions, appends ledger rows, consumes the approval used.
 */
import type {
  GateActivity,
  PasskeyRecord,
  PinRecord,
  QuoteRejection,
  SecurityEvent,
  SetupCodeRecord,
  WebSessionRecord,
} from '../auth/types.js';
import { BazaarError } from '../core/errors.js';
import { lineHash } from '../core/hash.js';
import type {
  Approval,
  Household,
  ISODateTime,
  LedgerOrderInput,
  Member,
  Place,
  Quote,
  Serviceability,
  ShopRequest,
  ShopResult,
} from '../core/types.js';
import type { DecisionRecorder, ExistingPlacement, GateRecord, PlacedRecord } from '../policy/gate.js';
import { countsAsSpend, type SpendRow } from '../policy/spend.js';
import type { Store } from './store.js';

const NINETY_DAYS_MS = 90 * 24 * 3_600_000;

export class MemoryStore implements Store {
  readonly households = new Map<string, Household>();
  readonly requests: ShopRequest[] = [];
  readonly results: ShopResult[] = [];
  readonly quotes = new Map<string, { householdId: string; quote: Quote }>();
  readonly approvals: Approval[] = [];
  readonly decisions: GateRecord[] = [];
  readonly placed: PlacedRecord[] = [];
  readonly orders: (LedgerOrderInput & { householdId: string })[] = [];
  private readonly spend: (SpendRow & { householdId: string })[] = [];
  /** sha256(member token) → member; only hashes are kept, as in the member_credentials table. */
  readonly credentials = new Map<string, { householdId: string; memberId: string; revokedAt?: ISODateTime }>();
  readonly passkeys = new Map<string, PasskeyRecord>();
  readonly sessions = new Map<string, WebSessionRecord>();
  readonly setupCodes = new Map<string, SetupCodeRecord>();
  readonly pins = new Map<string, PinRecord>();
  readonly securityEvents: SecurityEvent[] = [];
  readonly rejections: QuoteRejection[] = [];

  constructor(households: Household[] = []) {
    for (const h of households) this.households.set(h.id, structuredClone(h));
  }

  readonly recorder: DecisionRecorder = {
    recordDecision: (r: GateRecord) => {
      this.decisions.push(r);
      // Same as the DB recorder: the quote the gate saw is stored by hash (newest wins).
      this.keepNewestQuote(r.householdId, r.quote);
    },
    findPlaced: (householdId: string, quote: Quote): ExistingPlacement | undefined => {
      const p = this.placed.find(
        (x) =>
          x.householdId === householdId &&
          x.quote.hash === quote.hash &&
          x.order.placedAt >= quote.createdAt &&
          countsAsSpend(x.order),
      );
      return p ? { order: structuredClone(p.order), decision: structuredClone(p.decision) } : undefined;
    },
    recordPlaced: (r: PlacedRecord) => {
      this.placed.push(r);
      this.orders.push({
        householdId: r.householdId,
        supplierId: r.order.supplierId,
        supplierOrderId: r.order.supplierOrderId,
        placedAt: r.order.placedAt,
        placeId: r.placeId,
        supplierAddressId: r.quote.supplierAddressId,
        lines: r.quote.lines.map((l) => ({
          name: l.name,
          variantId: l.variantId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
          category: l.category,
          addedBy: r.memberId,
          ...(l.itemKey !== undefined ? { itemKey: l.itemKey } : {}),
        })),
        fees: r.quote.fees,
        total: r.quote.total,
        status: r.order.status,
        quoteHash: r.quote.hash,
        decision: r.decision,
        memberId: r.memberId,
      });
      this.spend.push({
        householdId: r.householdId,
        placedAt: r.order.placedAt,
        total: r.quote.total,
        status: r.order.status,
        decision: { verdict: r.decision.verdict, ...(r.approvalId ? { approvalId: r.approvalId } : {}) },
      });
      if (r.consumeApprovalId) {
        const a = this.approvals.find((x) => x.id === r.consumeApprovalId);
        if (a) a.consumedAt = r.order.placedAt;
      }
    },
  };

  /** Seed history (orders placed outside Bazaar, or earlier today) for cap tests. */
  addLedgerOrder(householdId: string, order: LedgerOrderInput, spend?: Pick<SpendRow, 'decision'>): void {
    this.orders.push({ householdId, ...order });
    this.spend.push({
      householdId,
      placedAt: order.placedAt,
      total: order.total,
      status: order.status,
      ...(spend?.decision !== undefined ? { decision: spend.decision } : {}),
    });
  }

  async loadHousehold(householdId: string): Promise<Household> {
    const h = this.households.get(householdId);
    if (!h) throw new BazaarError('NOT_FOUND', `household ${householdId} not found`);
    return structuredClone(h);
  }

  async findMemberByChannel(kind: 'whatsapp' | 'siri' | 'web', address: string) {
    for (const h of this.households.values()) {
      const m = h.members.find((x) => x.channels.some((c) => c.kind === kind && c.address === address));
      if (m) return { householdId: h.id, memberId: m.id };
    }
    return undefined;
  }

  async findMemberByTokenHash(tokenHash: string) {
    const c = this.credentials.get(tokenHash);
    if (!c || c.revokedAt !== undefined) return undefined;
    const h = this.households.get(c.householdId);
    if (!h?.members.some((m) => m.id === c.memberId)) return undefined;
    return { householdId: c.householdId, memberId: c.memberId };
  }

  async rotateMemberCredential(memberId: string, tokenHash: string): Promise<void> {
    const h = [...this.households.values()].find((x) => x.members.some((m) => m.id === memberId));
    if (!h) throw new BazaarError('UNKNOWN_MEMBER', `member ${memberId} not found`);
    const now = new Date().toISOString();
    for (const c of this.credentials.values())
      if (c.memberId === memberId && c.revokedAt === undefined) c.revokedAt = now;
    this.credentials.set(tokenHash, { householdId: h.id, memberId });
  }

  async savePlace(place: Place): Promise<void> {
    const h = this.households.get(place.householdId);
    if (!h) throw new BazaarError('NOT_FOUND', `household ${place.householdId} not found`);
    const copy = structuredClone(place);
    if (copy.isDefault) for (const p of h.places) if (p.id !== copy.id) p.isDefault = false;
    const i = h.places.findIndex((p) => p.id === copy.id);
    if (i >= 0) h.places[i] = copy;
    else h.places.push(copy);
  }

  async saveServiceability(placeId: string, records: Serviceability[]): Promise<void> {
    for (const h of this.households.values()) {
      const p = h.places.find((x) => x.id === placeId);
      if (p) p.serviceability = structuredClone(records);
    }
  }

  async saveRequest(request: ShopRequest): Promise<void> {
    this.requests.push(structuredClone(request));
  }

  async saveResult(result: ShopResult): Promise<void> {
    this.results.push(structuredClone(result));
  }

  async saveQuote(householdId: string, quote: Quote): Promise<void> {
    this.keepNewestQuote(householdId, quote);
  }

  /**
   * One stored quote per hash; a later re-quote of the same cart replaces it, so its createdAt is the latest. The
   * gate's idempotency check (placed at or after quote.createdAt) depends on this: an identical cart bought again
   * next week is a new purchase, not a replay of last week's order.
   */
  private keepNewestQuote(householdId: string, quote: Quote): void {
    const prev = this.quotes.get(quote.hash);
    if (!prev || prev.quote.createdAt < quote.createdAt) {
      this.quotes.set(quote.hash, { householdId, quote: structuredClone(quote) });
    }
  }

  async getQuote(hash: string) {
    const q = this.quotes.get(hash);
    return q ? structuredClone(q) : undefined;
  }

  async saveApproval(approval: Approval): Promise<void> {
    this.approvals.push(approval);
  }

  async consumeApproval(approvalId: string, at: ISODateTime): Promise<void> {
    const a = this.approvals.find((x) => x.id === approvalId);
    if (a && a.consumedAt === undefined) a.consumedAt = at;
  }

  async loadApprovals(quote: Quote): Promise<Approval[]> {
    const lh = lineHash(quote.lines);
    // Live objects on purpose: consumption by the recorder must be visible on the next read.
    return this.approvals.filter(
      (a) => a.consumedAt === undefined && (a.quoteHash === quote.hash || a.conditions?.lineHash === lh),
    );
  }

  async loadSpendRows(householdId: string, since: ISODateTime): Promise<SpendRow[]> {
    return this.spend
      .filter((r) => r.householdId === householdId && r.placedAt >= since)
      .map(({ householdId: _h, ...row }) => row);
  }

  async loadQuantityHistory(householdId: string, now: ISODateTime): Promise<Record<string, number>> {
    const since = Date.parse(now) - NINETY_DAYS_MS;
    const out: Record<string, number> = {};
    for (const o of this.orders) {
      if (o.householdId !== householdId || Date.parse(o.placedAt) < since || /fail|cancel/i.test(o.status)) continue;
      for (const l of o.lines) {
        if (!l.itemKey) continue;
        out[l.itemKey] = Math.max(out[l.itemKey] ?? 0, l.quantity);
      }
    }
    return out;
  }

  async loadLedgerOrders(householdId: string, since?: ISODateTime): Promise<LedgerOrderInput[]> {
    return this.orders
      .filter((o) => o.householdId === householdId && (since === undefined || o.placedAt >= since))
      .map(({ householdId: _h, ...o }) => o);
  }

  // ---------- identity (auth/types.ts IdentityStore) ----------

  private householdOfMember(memberId: string): Household | undefined {
    return [...this.households.values()].find((x) => x.members.some((m) => m.id === memberId));
  }

  async saveMember(member: Member): Promise<void> {
    const h = this.households.get(member.householdId);
    if (!h) throw new BazaarError('NOT_FOUND', `household ${member.householdId} not found`);
    for (const other of h.members) {
      if (other.id === member.id) continue;
      const clash = member.phones.find((p) => other.phones.includes(p));
      if (clash) throw new BazaarError('PHONE_TAKEN', `${clash} already belongs to another member`);
    }
    const copy = structuredClone(member);
    const i = h.members.findIndex((m) => m.id === member.id);
    if (i >= 0) h.members[i] = copy;
    else h.members.push(copy);
  }

  async listPasskeys(memberId: string): Promise<PasskeyRecord[]> {
    return [...this.passkeys.values()].filter((p) => p.memberId === memberId).map((p) => structuredClone(p));
  }

  async findPasskey(credentialId: string): Promise<PasskeyRecord | undefined> {
    const p = this.passkeys.get(credentialId);
    return p ? structuredClone(p) : undefined;
  }

  async savePasskey(passkey: PasskeyRecord): Promise<void> {
    if (this.passkeys.has(passkey.id)) throw new BazaarError('PASSKEY_EXISTS', 'credential already registered');
    this.passkeys.set(passkey.id, structuredClone(passkey));
  }

  async updatePasskeyCounter(credentialId: string, counter: number, at: ISODateTime): Promise<void> {
    const p = this.passkeys.get(credentialId);
    if (p) {
      p.counter = counter;
      p.lastUsedAt = at;
    }
  }

  async passkeyMemberIds(householdId: string): Promise<string[]> {
    const h = this.households.get(householdId);
    if (!h) return [];
    const ids = new Set([...this.passkeys.values()].map((p) => p.memberId));
    return h.members.filter((m) => ids.has(m.id)).map((m) => m.id);
  }

  async createSession(session: WebSessionRecord): Promise<void> {
    this.sessions.set(session.tokenHash, structuredClone(session));
  }

  async findSessionByTokenHash(tokenHash: string): Promise<WebSessionRecord | undefined> {
    const s = this.sessions.get(tokenHash);
    if (!s || !this.householdOfMember(s.memberId)) return undefined;
    return structuredClone(s);
  }

  async touchSession(id: string, lastSeenAt: ISODateTime, expiresAt: ISODateTime): Promise<void> {
    for (const s of this.sessions.values())
      if (s.id === id) {
        s.lastSeenAt = lastSeenAt;
        s.expiresAt = expiresAt;
      }
  }

  async revokeSession(id: string, at: ISODateTime): Promise<void> {
    for (const s of this.sessions.values()) if (s.id === id && s.revokedAt === undefined) s.revokedAt = at;
  }

  async createSetupCode(code: SetupCodeRecord): Promise<void> {
    for (const c of this.setupCodes.values())
      if (c.memberId === code.memberId && c.usedAt === undefined && c.revokedAt === undefined)
        c.revokedAt = code.createdAt;
    this.setupCodes.set(code.codeHash, structuredClone(code));
  }

  async findSetupCode(codeHash: string): Promise<SetupCodeRecord | undefined> {
    const c = this.setupCodes.get(codeHash);
    return c ? structuredClone(c) : undefined;
  }

  async consumeSetupCode(id: string, at: ISODateTime): Promise<boolean> {
    for (const c of this.setupCodes.values()) {
      if (c.id !== id) continue;
      if (c.usedAt !== undefined || c.revokedAt !== undefined) return false;
      c.usedAt = at;
      return true;
    }
    return false;
  }

  async getPin(memberId: string): Promise<PinRecord | undefined> {
    const p = this.pins.get(memberId);
    return p ? structuredClone(p) : undefined;
  }

  async savePin(pin: PinRecord): Promise<void> {
    this.pins.set(pin.memberId, structuredClone(pin));
  }

  async recordSecurityEvent(event: SecurityEvent): Promise<void> {
    this.securityEvents.push(structuredClone(event));
  }

  async saveRejection(rejection: QuoteRejection): Promise<void> {
    this.rejections.push(structuredClone(rejection));
  }

  async loadGateActivity(householdId: string, since: ISODateTime): Promise<GateActivity> {
    const decisions = this.decisions
      .filter((d) => d.householdId === householdId && d.evaluatedAt >= since)
      .map((d) => ({
        quoteHash: d.quote.hash,
        memberId: d.memberId,
        placeId: d.placeId,
        decision: {
          verdict: d.decision.verdict,
          reasons: structuredClone(d.decision.reasons),
          evaluatedAt: d.decision.evaluatedAt,
        },
      }));
    const hashes = new Set(decisions.map((d) => d.quoteHash));
    const quotes = [...hashes]
      .map((h) => this.quotes.get(h))
      .filter((q): q is { householdId: string; quote: Quote } => q !== undefined && q.householdId === householdId)
      .map((q) => structuredClone(q.quote));
    const placed = this.placed
      .filter((p) => p.householdId === householdId && hashes.has(p.quote.hash) && countsAsSpend(p.order))
      .map((p) => ({ quoteHash: p.quote.hash, placedAt: p.order.placedAt }));
    const rejections = this.rejections
      .filter((r) => r.householdId === householdId && hashes.has(r.quoteHash))
      .map((r) => ({ quoteHash: r.quoteHash, rejectedAt: r.rejectedAt }));
    return { decisions, quotes, placed, rejections };
  }
}
