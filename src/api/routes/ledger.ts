import type { FastifyInstance } from 'fastify';
import { currentMonth, summariseMonth } from '../../ledger/queries.js';
import { ApiError, householdIdOf, type ApiDeps } from '../http.js';

export function registerLedgerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Querystring: { month?: string; householdId?: string } }>('/ledger/summary', async (req) => {
    const now = deps.now?.() ?? new Date().toISOString();
    const month = req.query.month ?? currentMonth(now);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError(400, 'month must be YYYY-MM');
    const household = await deps.store.loadHousehold(householdIdOf(deps, req.query));
    // One extra day either side covers local-month boundaries; the summary filters exactly.
    const [y, m] = month.split('-').map(Number) as [number, number];
    const since = new Date(Date.UTC(y, m - 1, 1) - 2 * 86_400_000).toISOString();
    const orders = await deps.store.loadLedgerOrders(household.id, since);
    return summariseMonth(orders, month, {
      memberNames: Object.fromEntries(household.members.map((x) => [x.id, x.name])),
      placeNames: Object.fromEntries(household.places.map((p) => [p.id, p.nickname])),
    });
  });
}
