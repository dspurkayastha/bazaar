/**
 * Postgres-backed Store. Composes the ledger helpers in ./ledger.ts; no business logic here.
 * Not exercised by unit tests (no DB in tests); MemoryStore is the reference implementation.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import type { Store } from '../agent/store.js';
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
import type {
  Approval,
  Household,
  ISODateTime,
  ItemDefault,
  LedgerOrderInput,
  Member,
  Place,
  Profile,
  Quote,
  Serviceability,
  ShopRequest,
  ShopResult,
} from '../core/types.js';
import type { SpendRow } from '../policy/spend.js';
import type { Db } from './client.js';
import { conn, PgGateLock, type Tx } from './lock.js';
import { rotateMemberCredential } from './credentials.js';
import { DbDecisionRecorder, insertQuote, loadCandidateApprovals, loadSpendRows } from './ledger.js';
import {
  approvals,
  households,
  itemDefaults,
  ledgerLines,
  ledgerOrders,
  memberCredentials,
  memberPhones,
  memberPins,
  members,
  places,
  policyDecisions,
  profiles,
  quoteRejections,
  quotes,
  requests,
  securityEvents,
  setupCodes,
  webauthnCredentials,
  webSessions,
} from './schema.js';

const iso = (v: string | null): string | undefined => (v === null ? undefined : new Date(v).toISOString());

/** Postgres unique violation (e.g. the member_phones primary key). */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

const NINETY_DAYS_MS = 90 * 24 * 3_600_000;

const EMPTY_PROFILE = {
  peopleDefault: 2,
  pantryAssumed: [] as string[],
  recipes: [] as Profile['recipes'],
  usualLists: [] as Profile['usualLists'],
  languageHints: ['en'],
};

export class DbStore implements Store {
  readonly recorder: DbDecisionRecorder;

  readonly gateLock: PgGateLock;

  constructor(private readonly pool: Db) {
    this.recorder = new DbDecisionRecorder(pool);
    this.gateLock = new PgGateLock(pool);
  }

  /** Inside a gate run every query goes through the gate lock's transaction (src/db/lock.ts). */
  private get db(): Db | Tx {
    return conn(this.pool);
  }

  async loadHousehold(householdId: string): Promise<Household> {
    const db = this.db;
    const [h] = await db.select().from(households).where(eq(households.id, householdId));
    if (!h) throw new BazaarError('NOT_FOUND', `household ${householdId} not found`);
    const [ms, ps, [pr], ds, phones] = await Promise.all([
      db.select().from(members).where(eq(members.householdId, householdId)),
      db.select().from(places).where(eq(places.householdId, householdId)),
      db.select().from(profiles).where(eq(profiles.householdId, householdId)),
      db.select().from(itemDefaults).where(eq(itemDefaults.householdId, householdId)),
      db
        .select()
        .from(memberPhones)
        .where(eq(memberPhones.householdId, householdId))
        .orderBy(asc(memberPhones.position)),
    ]);
    const memberList: Member[] = ms.map((m) => ({
      id: m.id,
      householdId: m.householdId,
      name: m.name,
      role: m.role,
      channels: m.channels,
      phones: phones.filter((p) => p.memberId === m.id).map((p) => p.phone),
      ...(m.defaultPlaceId ? { defaultPlaceId: m.defaultPlaceId } : {}),
    }));
    const placeList: Place[] = ps.map((p) => ({
      id: p.id,
      householdId: p.householdId,
      key: p.key,
      nickname: p.nickname,
      aliases: p.aliases,
      canonicalAddress: p.canonicalAddress,
      city: p.city,
      ...(p.lat !== null ? { lat: p.lat } : {}),
      ...(p.lng !== null ? { lng: p.lng } : {}),
      supplierAddressIds: p.supplierAddressIds,
      serviceability: p.serviceability,
      trusted: p.trusted,
      ...(p.profileOverlay ? { profileOverlay: p.profileOverlay } : {}),
      isDefault: p.isDefault,
    }));
    const defaults: ItemDefault[] = ds.map((d) => ({
      key: d.key,
      aliases: d.aliases,
      ...(d.brand ? { brand: d.brand } : {}),
      ...(d.product ? { product: d.product } : {}),
      ...(d.size ? { size: d.size } : {}),
      ...(d.quantityPerHead !== null ? { quantityPerHead: d.quantityPerHead } : {}),
      category: d.category,
      ...(d.neverSubstitute ? { neverSubstitute: true } : {}),
      ...(d.supplierHints ? { supplierHints: d.supplierHints } : {}),
      origin: d.origin,
    }));
    return {
      id: h.id,
      name: h.name,
      members: memberList,
      places: placeList,
      profile: { householdId, ...(pr?.profile ?? EMPTY_PROFILE), defaults },
      policy: h.policy,
    };
  }

  async findMemberByChannel(kind: 'whatsapp' | 'siri' | 'web', address: string) {
    const needle = JSON.stringify([{ kind, address }]);
    const [m] = await this.db
      .select({ id: members.id, householdId: members.householdId })
      .from(members)
      .where(sql`${members.channels} @> ${needle}::jsonb`)
      .limit(1);
    return m ? { householdId: m.householdId, memberId: m.id } : undefined;
  }

  async findMemberByTokenHash(tokenHash: string) {
    const [m] = await this.db
      .select({ memberId: members.id, householdId: members.householdId })
      .from(memberCredentials)
      .innerJoin(members, eq(memberCredentials.memberId, members.id))
      .where(and(eq(memberCredentials.tokenHash, tokenHash), isNull(memberCredentials.revokedAt)))
      .limit(1);
    return m;
  }

  async rotateMemberCredential(memberId: string, tokenHash: string): Promise<void> {
    await rotateMemberCredential(this.db, memberId, tokenHash);
  }

  async savePlace(p: Place): Promise<void> {
    const values = {
      id: p.id,
      householdId: p.householdId,
      key: p.key,
      nickname: p.nickname,
      aliases: p.aliases,
      canonicalAddress: p.canonicalAddress,
      city: p.city,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
      supplierAddressIds: p.supplierAddressIds,
      serviceability: p.serviceability,
      trusted: p.trusted,
      profileOverlay: p.profileOverlay ?? null,
      isDefault: p.isDefault,
    };
    await this.db.transaction(async (tx) => {
      // At most one default per household: clear the old one first.
      if (p.isDefault) {
        await tx
          .update(places)
          .set({ isDefault: false })
          .where(and(eq(places.householdId, p.householdId), eq(places.isDefault, true)));
      }
      await tx.insert(places).values(values).onConflictDoUpdate({ target: places.id, set: values });
    });
  }

  async saveServiceability(placeId: string, records: Serviceability[]): Promise<void> {
    await this.db.update(places).set({ serviceability: records }).where(eq(places.id, placeId));
  }

  async saveRequest(r: ShopRequest): Promise<void> {
    await this.db
      .insert(requests)
      .values({
        id: r.id,
        householdId: r.householdId,
        memberId: r.memberId,
        channel: r.channel,
        text: r.text,
        receivedAt: r.receivedAt,
        context: r.context ?? null,
      })
      .onConflictDoNothing({ target: requests.id });
  }

  async saveResult(result: ShopResult): Promise<void> {
    await this.db.update(requests).set({ result }).where(eq(requests.id, result.requestId));
  }

  async saveQuote(householdId: string, quote: Quote, requestId?: string): Promise<void> {
    await insertQuote(this.db, householdId, quote, requestId);
  }

  async getQuote(hash: string) {
    const [row] = await this.db.select().from(quotes).where(eq(quotes.hash, hash));
    return row ? { householdId: row.householdId, quote: row.quote } : undefined;
  }

  async saveApproval(a: Approval): Promise<void> {
    await this.db.insert(approvals).values({
      id: a.id,
      quoteHash: a.quoteHash,
      memberId: a.memberId,
      placeId: a.placeId ?? null,
      supplierId: a.supplierId ?? null,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
      conditions: a.conditions ?? null,
      consumedAt: a.consumedAt ?? null,
    });
  }

  async consumeApproval(approvalId: string, at: ISODateTime): Promise<void> {
    await this.db
      .update(approvals)
      .set({ consumedAt: at })
      .where(and(eq(approvals.id, approvalId), isNull(approvals.consumedAt)));
  }

  loadApprovals(quote: Quote): Promise<Approval[]> {
    return loadCandidateApprovals(this.db, quote);
  }

  loadSpendRows(householdId: string, since: ISODateTime): Promise<SpendRow[]> {
    return loadSpendRows(this.db, householdId, since);
  }

  async loadQuantityHistory(householdId: string, now: ISODateTime): Promise<Record<string, number>> {
    const since = new Date(Date.parse(now) - NINETY_DAYS_MS).toISOString();
    const rows = await this.db
      .select({ itemKey: ledgerLines.itemKey, max: sql<number>`max(${ledgerLines.quantity})`.mapWith(Number) })
      .from(ledgerLines)
      .innerJoin(ledgerOrders, eq(ledgerLines.orderId, ledgerOrders.id))
      .where(
        and(
          eq(ledgerOrders.householdId, householdId),
          gte(ledgerOrders.placedAt, since),
          isNotNull(ledgerLines.itemKey),
          notInArray(ledgerOrders.status, ['failed', 'cancelled']),
        ),
      )
      .groupBy(ledgerLines.itemKey);
    const out: Record<string, number> = {};
    for (const r of rows) if (r.itemKey) out[r.itemKey] = r.max;
    return out;
  }

  async loadLedgerOrders(householdId: string, since?: ISODateTime): Promise<LedgerOrderInput[]> {
    const where = since
      ? and(eq(ledgerOrders.householdId, householdId), gte(ledgerOrders.placedAt, since))
      : eq(ledgerOrders.householdId, householdId);
    const orders = await this.db.select().from(ledgerOrders).where(where);
    if (orders.length === 0) return [];
    const lines = await this.db
      .select({ line: ledgerLines })
      .from(ledgerLines)
      .innerJoin(ledgerOrders, eq(ledgerLines.orderId, ledgerOrders.id))
      .where(where);
    const byOrder = new Map<string, LedgerOrderInput['lines']>();
    for (const { line: l } of lines) {
      const list = byOrder.get(l.orderId) ?? [];
      list.push({
        name: l.name,
        ...(l.variantId ? { variantId: l.variantId } : {}),
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        ...(l.category ? { category: l.category } : {}),
        ...(l.addedBy ? { addedBy: l.addedBy } : {}),
        ...(l.itemKey ? { itemKey: l.itemKey } : {}),
      });
      byOrder.set(l.orderId, list);
    }
    return orders.map((o) => ({
      supplierId: o.supplierId,
      supplierOrderId: o.supplierOrderId,
      placedAt: o.placedAt,
      ...(o.placeId ? { placeId: o.placeId } : {}),
      ...(o.supplierAddressId ? { supplierAddressId: o.supplierAddressId } : {}),
      lines: byOrder.get(o.id) ?? [],
      fees: o.fees,
      total: o.total,
      status: o.status,
      ...(o.memberId ? { memberId: o.memberId } : {}),
      ...(o.quoteHash ? { quoteHash: o.quoteHash } : {}),
      ...(o.decision ? { decision: o.decision } : {}),
    }));
  }

  // ---------- identity (auth/types.ts IdentityStore) ----------

  async saveMember(m: Member): Promise<void> {
    const set = { name: m.name, role: m.role, channels: m.channels, defaultPlaceId: m.defaultPlaceId ?? null };
    try {
      await this.db.transaction(async (tx) => {
        await tx
          .insert(members)
          .values({ id: m.id, householdId: m.householdId, ...set })
          .onConflictDoUpdate({ target: members.id, set });
        await tx.delete(memberPhones).where(eq(memberPhones.memberId, m.id));
        if (m.phones.length > 0) {
          await tx
            .insert(memberPhones)
            .values(m.phones.map((phone, position) => ({ householdId: m.householdId, phone, memberId: m.id, position })));
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new BazaarError('PHONE_TAKEN', 'a phone already belongs to another member');
      throw err;
    }
  }

  private passkeyOf(r: typeof webauthnCredentials.$inferSelect): PasskeyRecord {
    return {
      id: r.id,
      memberId: r.memberId,
      publicKey: r.publicKey,
      counter: r.counter,
      transports: r.transports,
      ...(r.deviceType !== null ? { deviceType: r.deviceType } : {}),
      ...(r.backedUp !== null ? { backedUp: r.backedUp } : {}),
      createdAt: iso(r.createdAt)!,
      ...(r.lastUsedAt !== null ? { lastUsedAt: iso(r.lastUsedAt)! } : {}),
    };
  }

  async listPasskeys(memberId: string): Promise<PasskeyRecord[]> {
    const rows = await this.db.select().from(webauthnCredentials).where(eq(webauthnCredentials.memberId, memberId));
    return rows.map((r) => this.passkeyOf(r));
  }

  async findPasskey(credentialId: string): Promise<PasskeyRecord | undefined> {
    const [r] = await this.db.select().from(webauthnCredentials).where(eq(webauthnCredentials.id, credentialId));
    return r ? this.passkeyOf(r) : undefined;
  }

  async savePasskey(p: PasskeyRecord): Promise<void> {
    await this.db.insert(webauthnCredentials).values({
      id: p.id,
      memberId: p.memberId,
      publicKey: p.publicKey,
      counter: p.counter,
      transports: p.transports,
      deviceType: p.deviceType ?? null,
      backedUp: p.backedUp ?? null,
      createdAt: p.createdAt,
    });
  }

  async updatePasskeyCounter(credentialId: string, counter: number, at: ISODateTime): Promise<void> {
    await this.db
      .update(webauthnCredentials)
      .set({ counter, lastUsedAt: at })
      .where(eq(webauthnCredentials.id, credentialId));
  }

  async passkeyMemberIds(householdId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ memberId: webauthnCredentials.memberId })
      .from(webauthnCredentials)
      .innerJoin(members, eq(webauthnCredentials.memberId, members.id))
      .where(eq(members.householdId, householdId));
    return rows.map((r) => r.memberId);
  }

  async createSession(s: WebSessionRecord): Promise<void> {
    await this.db.insert(webSessions).values({
      id: s.id,
      memberId: s.memberId,
      householdId: s.householdId,
      tokenHash: s.tokenHash,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
    });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<WebSessionRecord | undefined> {
    const [r] = await this.db.select().from(webSessions).where(eq(webSessions.tokenHash, tokenHash));
    if (!r) return undefined;
    return {
      id: r.id,
      memberId: r.memberId,
      householdId: r.householdId,
      tokenHash: r.tokenHash,
      createdAt: iso(r.createdAt)!,
      lastSeenAt: iso(r.lastSeenAt)!,
      expiresAt: iso(r.expiresAt)!,
      ...(r.revokedAt !== null ? { revokedAt: iso(r.revokedAt)! } : {}),
    };
  }

  async touchSession(id: string, lastSeenAt: ISODateTime, expiresAt: ISODateTime): Promise<void> {
    await this.db.update(webSessions).set({ lastSeenAt, expiresAt }).where(eq(webSessions.id, id));
  }

  async revokeSession(id: string, at: ISODateTime): Promise<void> {
    await this.db
      .update(webSessions)
      .set({ revokedAt: at })
      .where(and(eq(webSessions.id, id), isNull(webSessions.revokedAt)));
  }

  async createSetupCode(c: SetupCodeRecord): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(setupCodes)
        .set({ revokedAt: c.createdAt })
        .where(and(eq(setupCodes.memberId, c.memberId), isNull(setupCodes.usedAt), isNull(setupCodes.revokedAt)));
      await tx.insert(setupCodes).values({
        id: c.id,
        memberId: c.memberId,
        householdId: c.householdId,
        codeHash: c.codeHash,
        createdBy: c.createdBy ?? null,
        createdAt: c.createdAt,
        expiresAt: c.expiresAt,
      });
    });
  }

  async findSetupCode(codeHash: string): Promise<SetupCodeRecord | undefined> {
    const [r] = await this.db.select().from(setupCodes).where(eq(setupCodes.codeHash, codeHash));
    if (!r) return undefined;
    return {
      id: r.id,
      memberId: r.memberId,
      householdId: r.householdId,
      codeHash: r.codeHash,
      ...(r.createdBy !== null ? { createdBy: r.createdBy } : {}),
      createdAt: iso(r.createdAt)!,
      expiresAt: iso(r.expiresAt)!,
      ...(r.usedAt !== null ? { usedAt: iso(r.usedAt)! } : {}),
      ...(r.revokedAt !== null ? { revokedAt: iso(r.revokedAt)! } : {}),
    };
  }

  async consumeSetupCode(id: string, at: ISODateTime): Promise<boolean> {
    const rows = await this.db
      .update(setupCodes)
      .set({ usedAt: at })
      .where(and(eq(setupCodes.id, id), isNull(setupCodes.usedAt), isNull(setupCodes.revokedAt)))
      .returning({ id: setupCodes.id });
    return rows.length === 1;
  }

  async getPin(memberId: string): Promise<PinRecord | undefined> {
    const [r] = await this.db.select().from(memberPins).where(eq(memberPins.memberId, memberId));
    if (!r) return undefined;
    return {
      memberId: r.memberId,
      hash: r.hash,
      setAt: iso(r.setAt)!,
      failures: r.failures,
      consecutive: r.consecutive,
      ...(r.lockedUntil !== null ? { lockedUntil: iso(r.lockedUntil)! } : {}),
      ...(r.hardLockedAt !== null ? { hardLockedAt: iso(r.hardLockedAt)! } : {}),
    };
  }

  async savePin(p: PinRecord): Promise<void> {
    const values = {
      memberId: p.memberId,
      hash: p.hash,
      setAt: p.setAt,
      failures: p.failures,
      consecutive: p.consecutive,
      lockedUntil: p.lockedUntil ?? null,
      hardLockedAt: p.hardLockedAt ?? null,
    };
    await this.db.insert(memberPins).values(values).onConflictDoUpdate({ target: memberPins.memberId, set: values });
  }

  async recordSecurityEvent(e: SecurityEvent): Promise<void> {
    await this.db.insert(securityEvents).values({
      id: e.id,
      householdId: e.householdId,
      memberId: e.memberId,
      kind: e.kind,
      at: e.at,
      detail: e.detail ?? null,
    });
  }

  async saveRejection(r: QuoteRejection): Promise<void> {
    await this.db.insert(quoteRejections).values(r);
  }

  async loadGateActivity(householdId: string, since: ISODateTime): Promise<GateActivity> {
    const rows = await this.db
      .select()
      .from(policyDecisions)
      .where(and(eq(policyDecisions.householdId, householdId), gte(policyDecisions.evaluatedAt, since)));
    const decisions = rows
      .filter((r) => r.memberId !== null && r.placeId !== null)
      .map((r) => ({
        quoteHash: r.quoteHash,
        memberId: r.memberId!,
        placeId: r.placeId!,
        decision: { verdict: r.verdict, reasons: r.reasons, evaluatedAt: iso(r.evaluatedAt)! },
      }));
    const hashes = [...new Set(decisions.map((d) => d.quoteHash))];
    if (hashes.length === 0) return { decisions, quotes: [], placed: [], rejections: [] };
    const [qs, placed, rejected] = await Promise.all([
      this.db
        .select({ quote: quotes.quote })
        .from(quotes)
        .where(and(eq(quotes.householdId, householdId), inArray(quotes.hash, hashes))),
      this.db
        .select({ quoteHash: ledgerOrders.quoteHash, placedAt: ledgerOrders.placedAt })
        .from(ledgerOrders)
        .where(
          and(
            eq(ledgerOrders.householdId, householdId),
            inArray(ledgerOrders.quoteHash, hashes),
            notInArray(ledgerOrders.status, ['failed', 'cancelled']),
          ),
        ),
      this.db
        .select({ quoteHash: quoteRejections.quoteHash, rejectedAt: quoteRejections.rejectedAt })
        .from(quoteRejections)
        .where(and(eq(quoteRejections.householdId, householdId), inArray(quoteRejections.quoteHash, hashes))),
    ]);
    return {
      decisions,
      quotes: qs.map((q) => q.quote),
      placed: placed.map((p) => ({ quoteHash: p.quoteHash!, placedAt: iso(p.placedAt)! })),
      rejections: rejected.map((r) => ({ quoteHash: r.quoteHash, rejectedAt: iso(r.rejectedAt)! })),
    };
  }
}
