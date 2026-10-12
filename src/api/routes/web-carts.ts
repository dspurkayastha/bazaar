/**
 * The web app's carts and ledger (docs/WEB_API.md "Routes"):
 *
 *   GET  /api/carts                         held carts (owner: every member's; others: their own) + recent orders
 *   POST /api/carts/:quoteHash/approve      owner; `{pin?}`; the approval service (PIN above the threshold) + gate
 *   POST /api/carts/:quoteHash/reject       owner or the member who built it; clears the supplier cart only if it
 *                                           still holds exactly that quote
 *   GET  /api/ledger?month=YYYY-MM          owner: the household; others: their own lines
 */
import type { FastifyInstance } from 'fastify';
import { newId } from '../../core/ids.js';
import { currentMonth, summariseMonth } from '../../ledger/queries.js';
import { processGateLock } from '../../policy/lock.js';
import { HELD_WINDOW_MS, heldCarts, ownLedger, recentOrders } from '../carts.js';
import { ApiError, body, optString, pinThreshold, type ApiDeps } from '../http.js';
import { approveQuote } from './approve.js';
import { requireOwner, whoIs } from './web-auth.js';

const RECENT_WINDOW_MS = 30 * 24 * 3_600_000;
const HASH = /^[0-9a-f]{64}$/;

export function registerWebCartRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const nowOf = () => deps.now?.() ?? new Date().toISOString();
  const hashOf = (raw: string) => {
    if (!HASH.test(raw)) throw new ApiError(404, 'No such cart.', 'not_found');
    return raw;
  };

  app.get('/api/carts', { config: { auth: 'session' } }, async (req) => {
    const { household, member } = await whoIs(deps, req);
    const now = Date.parse(nowOf());
    const [activity, orders] = await Promise.all([
      deps.store.loadGateActivity(household.id, new Date(now - HELD_WINDOW_MS).toISOString()),
      deps.store.loadLedgerOrders(household.id, new Date(now - RECENT_WINDOW_MS).toISOString()),
    ]);
    return {
      held: heldCarts(activity, household, member, pinThreshold(deps)),
      recent: recentOrders(orders, household, member),
    };
  });

  app.post<{ Params: { quoteHash: string } }>(
    '/api/carts/:quoteHash/approve',
    { config: { auth: 'session' } },
    async (req) => {
      const { household, member } = await whoIs(deps, req);
      requireOwner(member);
      const o = body(req.body ?? {});
      const pin = optString(o, 'pin', 16);
      const out = await approveQuote(
        deps,
        hashOf(req.params.quoteHash),
        { householdId: household.id, memberId: member.id },
        pin !== undefined ? { pin } : {},
      );
      const placed = out.order !== undefined && (out.placed || out.alreadyPlaced === true);
      return {
        decision: out.decision,
        ...(placed ? { order: out.order } : {}),
        ...(out.needsPin ? { needsPin: true } : {}),
        ...(out.alreadyPlaced ? { alreadyPlaced: true } : {}),
        ...(out.requote ? { requote: true } : {}),
      };
    },
  );

  app.post<{ Params: { quoteHash: string } }>(
    '/api/carts/:quoteHash/reject',
    { config: { auth: 'session' } },
    async (req) => {
      const { household, member } = await whoIs(deps, req);
      const quoteHash = hashOf(req.params.quoteHash);
      const stored = await deps.store.getQuote(quoteHash);
      if (!stored || stored.householdId !== household.id) throw new ApiError(404, 'No such cart.', 'not_found');
      const { quote } = stored;
      if (member.role !== 'owner') {
        const activity = await deps.store.loadGateActivity(household.id, quote.createdAt);
        const first = activity.decisions
          .filter((d) => d.quoteHash === quoteHash)
          .sort((a, b) => a.decision.evaluatedAt.localeCompare(b.decision.evaluatedAt))[0];
        if (first?.memberId !== member.id)
          throw new ApiError(403, 'Only an owner or the member who built this cart can reject it.', 'forbidden');
      }
      const at = nowOf();
      await deps.store.saveRejection({
        id: newId('rj'),
        householdId: household.id,
        quoteHash,
        memberId: member.id,
        rejectedAt: at,
      });
      // Any live owner approval for this exact cart must not pay later.
      for (const a of await deps.store.loadApprovals(quote))
        if (a.quoteHash === quoteHash && !a.conditions) await deps.store.consumeApproval(a.id, at);
      // Clear the supplier cart only if it still is this quote, under the gate lock so no placement interleaves.
      const supplier = deps.suppliers.find((s) => s.id === quote.supplierId);
      const place = household.places.find((p) => p.id === quote.placeId);
      let cleared = false;
      if (supplier && place) {
        const lock = deps.store.gateLock ?? processGateLock;
        try {
          cleared = await lock.run(household.id, async () => {
            const live = await supplier.readCart(place);
            if (live.hash !== quoteHash) return false;
            await supplier.clearCart();
            return true;
          });
        } catch (err) {
          req.log.warn({ event: 'reject_clear_failed', message: err instanceof Error ? err.message : String(err) });
        }
      }
      return { ok: true, cleared };
    },
  );

  app.get<{ Querystring: { month?: string } }>('/api/ledger', { config: { auth: 'session' } }, async (req) => {
    const { household, member } = await whoIs(deps, req);
    const month = req.query.month ?? currentMonth(nowOf());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError(400, 'month must be YYYY-MM', 'bad_month');
    const [y, m] = month.split('-').map(Number) as [number, number];
    const since = new Date(Date.UTC(y, m - 1, 1) - 2 * 86_400_000).toISOString();
    const orders = await deps.store.loadLedgerOrders(household.id, since);
    return summariseMonth(member.role === 'owner' ? orders : ownLedger(orders, member.id), month, {
      memberNames: Object.fromEntries(household.members.map((x) => [x.id, x.name])),
      placeNames: Object.fromEntries(household.places.map((p) => [p.id, p.nickname])),
    });
  });
}
