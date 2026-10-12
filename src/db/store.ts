/**
 * Postgres-backed Store. Composes the ledger helpers in ./ledger.ts; no business logic here.
 * Not exercised by unit tests (no DB in tests); MemoryStore is the reference implementation.
 */
import { and, eq, gte, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import type { Store } from '../agent/store.js';
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
  members,
  places,
  profiles,
  quotes,
  requests,
} from './schema.js';

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
    const [ms, ps, [pr], ds] = await Promise.all([
      db.select().from(members).where(eq(members.householdId, householdId)),
      db.select().from(places).where(eq(places.householdId, householdId)),
      db.select().from(profiles).where(eq(profiles.householdId, householdId)),
      db.select().from(itemDefaults).where(eq(itemDefaults.householdId, householdId)),
    ]);
    const memberList: Member[] = ms.map((m) => ({
      id: m.id,
      householdId: m.householdId,
      name: m.name,
      role: m.role,
      channels: m.channels,
      ...(m.defaultPlaceId ? { defaultPlaceId: m.defaultPlaceId } : {}),
    }));
    const placeList: Place[] = ps.map((p) => ({
      id: p.id,
      householdId: p.householdId,
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
      ...(o.quoteHash ? { quoteHash: o.quoteHash } : {}),
      ...(o.decision ? { decision: o.decision } : {}),
    }));
  }
}
