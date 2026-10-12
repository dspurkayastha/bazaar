/**
 * POST /approve { quoteHash } with the owner's own bearer token: an owner approves exactly one quote hash. The
 * approving member is the token's member; a `memberId` in the body is ignored. We store an Approval
 * (30 min, single use), then re-run the gate for that quote; the gate places only if it now says PAY.
 * The decision (PAY / HOLD / BLOCK) is returned as data; 4xx is only for bad input and non-owners.
 */
import type { FastifyInstance } from 'fastify';
import { gateLine } from '../../agent/tools.js';
import { PolicyBlock, PolicyHold } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import type { Approval, PlacedOrder, PolicyDecision } from '../../core/types.js';
import { loadingContextBuilder } from '../../policy/context.js';
import { needsRequote, placeWithGate } from '../../policy/gate.js';
import { memberOf, type AuthedMember } from '../auth.js';
import { ApiError, body, reqString, type ApiDeps } from '../http.js';

export const APPROVAL_TTL_MS = 30 * 60_000;

export interface ApproveOutcome {
  approval: Approval;
  decision: PolicyDecision;
  placed: boolean;
  order?: PlacedOrder;
  /** True when this quote had already been placed (a repeat approval): `order` is that order, nothing new was sent. */
  alreadyPlaced?: boolean;
  /** True when the cart changed since the quote and the agent must build a new one. */
  requote: boolean;
  gateLine: string;
}

export async function approveQuote(deps: ApiDeps, quoteHash: string, who: AuthedMember): Promise<ApproveOutcome> {
  const stored = await deps.store.getQuote(quoteHash);
  // Another household's quote is indistinguishable from no quote.
  if (!stored || stored.householdId !== who.householdId) throw new ApiError(404, 'no quote with that hash');
  const { quote } = stored;
  const memberId = who.memberId;
  const household = await deps.store.loadHousehold(stored.householdId);
  const member = household.members.find((m) => m.id === memberId);
  if (!member) throw new ApiError(404, 'unknown member');
  if (member.role !== 'owner') throw new ApiError(403, 'only an owner can approve');
  const place = household.places.find((p) => p.id === quote.placeId);
  if (!place) throw new ApiError(404, "the quote's place no longer exists");
  const supplier = deps.suppliers.find((s) => s.id === quote.supplierId);
  if (!supplier) throw new ApiError(409, `${quote.supplierId} is not available`);

  const now = deps.now?.() ?? new Date().toISOString();
  const approval: Approval = {
    id: newId('ap'),
    quoteHash,
    memberId,
    placeId: quote.placeId,
    supplierId: quote.supplierId,
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + APPROVAL_TTL_MS).toISOString(),
  };
  await deps.store.saveApproval(approval);

  const payment = deps.payment ?? { kind: 'cod' as const };
  try {
    // Approvals, spend and quantity history are loaded inside the household's gate lock; a double tap on
    // /approve queues behind the first and gets the first's order back (idempotent on the quote).
    const res = await placeWithGate({
      supplier,
      payment,
      recorder: deps.store.recorder,
      ...(deps.store.gateLock ? { lock: deps.store.gateLock } : {}),
      ctxBuilder: loadingContextBuilder(deps.store, { household, place, quote, requestingMember: member, now }),
    });
    return {
      approval,
      decision: res.decision,
      placed: !res.replayed,
      ...(res.replayed ? { alreadyPlaced: true } : {}),
      order: res.order,
      requote: false,
      gateLine: gateLine({ decision: res.decision, quote, order: res.order, payment }),
    };
  } catch (err) {
    if (err instanceof PolicyHold || err instanceof PolicyBlock) {
      return {
        approval,
        decision: err.decision,
        placed: false,
        requote: needsRequote(err),
        gateLine: gateLine({ decision: err.decision, quote, payment }),
      };
    }
    throw err;
  }
}

export function registerApproveRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/approve', { config: { auth: 'member' } }, async (req) => {
    const o = body(req.body);
    return approveQuote(deps, reqString(o, 'quoteHash', 128), memberOf(req));
  });
}
