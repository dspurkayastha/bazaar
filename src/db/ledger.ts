/**
 * Postgres-backed ledger persistence for the gate. Appends only; never decides.
 * Not exercised by unit tests (no DB in tests); the in-memory recorder in test/gate.test.ts is the reference.
 */
import { and, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { lineHash } from '../core/hash.js';
import { newId } from '../core/ids.js';
import type { Approval, ISODateTime, Quote } from '../core/types.js';
import type { DecisionRecorder, GateRecord, PlacedRecord } from '../policy/gate.js';
import type { SpendRow } from '../policy/spend.js';
import type { Db } from './client.js';
import { approvals, ledgerLines, ledgerOrders, policyDecisions, quotes } from './schema.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Store a raw quote. The same cart re-quoted yields the same hash, so duplicates are ignored. */
export async function insertQuote(db: Db | Tx, householdId: string, quote: Quote, requestId?: string): Promise<void> {
  await db
    .insert(quotes)
    .values({
      id: quote.id,
      hash: quote.hash,
      householdId,
      requestId: requestId ?? null,
      supplierId: quote.supplierId,
      placeId: quote.placeId,
      supplierAddressId: quote.supplierAddressId,
      total: quote.total,
      quote,
    })
    .onConflictDoNothing({ target: quotes.hash });
}

export class DbDecisionRecorder implements DecisionRecorder {
  constructor(private readonly db: Db) {}

  async recordDecision(r: GateRecord): Promise<void> {
    await this.db.transaction(async (tx) => {
      await insertQuote(tx, r.householdId, r.quote);
      await tx.insert(policyDecisions).values({
        id: newId('pd'),
        householdId: r.householdId,
        quoteHash: r.quote.hash,
        liveCartHash: r.liveCart.hash,
        placeId: r.placeId,
        memberId: r.memberId,
        verdict: r.decision.verdict,
        reasons: r.decision.reasons,
        approvalId: r.approvalId ?? null,
        approvalUsed: r.approvalUsed,
        unattended: r.unattended,
        evaluatedAt: r.evaluatedAt,
      });
    });
  }

  async recordPlaced(r: PlacedRecord): Promise<void> {
    await this.db.transaction(async (tx) => {
      const orderId = newId('lo');
      const inserted = await tx
        .insert(ledgerOrders)
        .values({
          id: orderId,
          householdId: r.householdId,
          supplierId: r.order.supplierId,
          supplierOrderId: r.order.supplierOrderId,
          placedAt: r.order.placedAt,
          placeId: r.placeId,
          supplierAddressId: r.quote.supplierAddressId,
          memberId: r.memberId,
          fees: r.quote.fees,
          total: r.quote.total,
          status: r.order.status,
          quoteHash: r.quote.hash,
          decision: r.decision,
          approvalId: r.approvalId ?? null,
          unattended: r.unattended,
          raw: r.order,
        })
        .onConflictDoNothing({ target: [ledgerOrders.supplierId, ledgerOrders.supplierOrderId] })
        .returning({ id: ledgerOrders.id });
      if (inserted.length > 0 && r.quote.lines.length > 0) {
        await tx.insert(ledgerLines).values(
          r.quote.lines.map((l) => ({
            id: newId('ll'),
            orderId,
            name: l.name,
            variantId: l.variantId,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            lineTotal: l.lineTotal,
            category: l.category,
            addedBy: r.memberId,
            itemKey: l.itemKey ?? null,
          })),
        );
      }
      if (r.consumeApprovalId !== undefined) {
        await tx
          .update(approvals)
          .set({ consumedAt: r.order.placedAt })
          .where(and(eq(approvals.id, r.consumeApprovalId), isNull(approvals.consumedAt)));
      }
      await tx
        .update(policyDecisions)
        .set({ supplierOrderId: r.order.supplierOrderId })
        .where(and(eq(policyDecisions.quoteHash, r.quote.hash), eq(policyDecisions.evaluatedAt, r.evaluatedAt)));
    });
  }
}

/** Ledger rows for the spend helpers (load from the start of the local month or earlier). */
export async function loadSpendRows(db: Db, householdId: string, since: ISODateTime): Promise<SpendRow[]> {
  const rows = await db
    .select({
      placedAt: ledgerOrders.placedAt,
      total: ledgerOrders.total,
      status: ledgerOrders.status,
      approvalId: ledgerOrders.approvalId,
      unattended: ledgerOrders.unattended,
    })
    .from(ledgerOrders)
    .where(and(eq(ledgerOrders.householdId, householdId), gte(ledgerOrders.placedAt, since)));
  return rows.map((r) => ({
    placedAt: r.placedAt,
    total: r.total,
    status: r.status,
    decision: r.unattended
      ? { verdict: 'PAY' as const }
      : r.approvalId
        ? { verdict: 'PAY' as const, approvalId: r.approvalId }
        : null,
  }));
}

/** Unconsumed approvals that could cover this quote: bound to its hash, or line-bound to its lines. */
export async function loadCandidateApprovals(db: Db, quote: Quote): Promise<Approval[]> {
  const rows = await db
    .select()
    .from(approvals)
    .where(
      and(
        isNull(approvals.consumedAt),
        or(eq(approvals.quoteHash, quote.hash), sql`${approvals.conditions}->>'lineHash' = ${lineHash(quote.lines)}`),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    quoteHash: r.quoteHash,
    memberId: r.memberId,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    ...(r.conditions ? { conditions: r.conditions } : {}),
  }));
}
