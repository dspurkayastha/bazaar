/**
 * The approval service, and POST /approve { quoteHash, pin? } (v1, owner's own bearer token).
 *
 * approveQuote: an owner approves exactly one quote hash. The approving member is the caller's (token, session or
 * voice connection); a `memberId` in a body is ignored. Then the gate re-runs for that quote and places only on PAY.
 *
 * PIN precondition (docs/WEB_API.md "PIN"): when the quote's total is above PIN_REQUIRED_ABOVE_RUPEES (exact paise),
 * no Approval is created unless THIS call carries the owner's PIN (checked here, counting toward the lockout) or a
 * PinProof from verifyPinForApproval (the phone keypad path). Without one the outcome is `needsPin: true` and
 * nothing is stored. The engine's verdict logic is unchanged: the PIN only gates creating the approval; the gate
 * still re-reads the live cart, checks the hash, and BLOCK is never approvable.
 *
 * The decision (PAY / HOLD / BLOCK) is returned as data; 4xx is for bad input, non-owners, a wrong PIN (403
 * pin_incorrect), no PIN set (409 pin_not_set) and a locked PIN (423 pin_locked).
 */
import type { FastifyInstance } from 'fastify';
import { gateLine } from '../../agent/tools.js';
import type { PinProof } from '../../auth/pin.js';
import { PolicyBlock, PolicyHold } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import { formatINR } from '../../core/money.js';
import type { Approval, PlacedOrder, PolicyDecision } from '../../core/types.js';
import { loadingContextBuilder } from '../../policy/context.js';
import { needsRequote, placeWithGate } from '../../policy/gate.js';
import { memberOf, type AuthedMember } from '../auth.js';
import { ApiError, body, optString, pinThreshold, pinsOf, reqString, type ApiDeps } from '../http.js';

export const APPROVAL_TTL_MS = 30 * 60_000;

export interface ApproveOutcome {
  /** Absent when nothing was approved (needsPin). */
  approval?: Approval;
  decision: PolicyDecision;
  placed: boolean;
  order?: PlacedOrder;
  /** True when this quote had already been placed (a repeat approval): `order` is that order, nothing new was sent. */
  alreadyPlaced?: boolean;
  /** True when the cart changed since the quote and the agent must build a new one. */
  requote: boolean;
  /** The total is above the PIN threshold and no PIN came with the request: nothing was approved. */
  needsPin?: boolean;
  gateLine: string;
}

/** How the owner proved it is them, beyond the session/token: the PIN digits, or a keypad PinProof. */
export interface ApprovalFactor {
  pin?: string;
  pinProof?: PinProof;
}

/** Turn a failed PIN check into the HTTP error the web app shows. Never echoes the PIN. */
export async function requirePin(deps: ApiDeps, memberId: string, factor: ApprovalFactor): Promise<void> {
  const pins = pinsOf(deps);
  if (factor.pinProof) {
    if (!pins.consumeProof(factor.pinProof, memberId))
      throw new ApiError(403, 'The PIN check expired; enter it again.', 'pin_required');
    return;
  }
  const v = await pins.verifyPinForApproval(memberId, factor.pin ?? '');
  if (v.ok) {
    pins.consumeProof(v.proof, memberId);
    return;
  }
  switch (v.reason) {
    case 'not_set':
      throw new ApiError(409, 'Set a PIN first (Household → Security).', 'pin_not_set');
    case 'invalid':
      throw new ApiError(400, 'The PIN is 4 to 6 digits.', 'pin_invalid');
    case 'locked':
      throw new ApiError(
        423,
        v.lock.hard
          ? 'PIN approvals are locked. Reset the PIN from Household → Security.'
          : 'Too many wrong PINs. Try again in 15 minutes.',
        'pin_locked',
        { pinLocked: true, ...(v.lock.until ? { lockedUntil: v.lock.until } : {}), hardLocked: v.lock.hard },
      );
    case 'incorrect':
      if (v.lockedNow?.locked)
        throw new ApiError(
          423,
          v.lockedNow.hard
            ? 'Wrong PIN. PIN approvals are now locked until the PIN is reset.'
            : 'Wrong PIN. PIN approvals are locked for 15 minutes.',
          'pin_locked',
          {
            pinLocked: true,
            ...(v.lockedNow.until ? { lockedUntil: v.lockedNow.until } : {}),
            hardLocked: v.lockedNow.hard,
          },
        );
      throw new ApiError(403, 'Wrong PIN.', 'pin_incorrect', { attemptsLeft: v.attemptsLeft });
  }
}

export async function approveQuote(
  deps: ApiDeps,
  quoteHash: string,
  who: AuthedMember,
  factor: ApprovalFactor = {},
): Promise<ApproveOutcome> {
  const stored = await deps.store.getQuote(quoteHash);
  // Another household's quote is indistinguishable from no quote.
  if (!stored || stored.householdId !== who.householdId) throw new ApiError(404, 'no quote with that hash');
  const { quote } = stored;
  const memberId = who.memberId;
  const household = await deps.store.loadHousehold(stored.householdId);
  const member = household.members.find((m) => m.id === memberId);
  if (!member) throw new ApiError(404, 'unknown member');
  if (member.role !== 'owner') throw new ApiError(403, 'only an owner can approve', 'owner_required');
  const place = household.places.find((p) => p.id === quote.placeId);
  if (!place) throw new ApiError(404, "the quote's place no longer exists");
  const supplier = deps.suppliers.find((s) => s.id === quote.supplierId);
  if (!supplier) throw new ApiError(409, `${quote.supplierId} is not available`);

  const now = deps.now?.() ?? new Date().toISOString();
  const payment = deps.payment ?? { kind: 'cod' as const };

  // The PIN is a precondition of creating the approval, never an input to the engine.
  if (quote.total > pinThreshold(deps)) {
    if (factor.pin === undefined && factor.pinProof === undefined) {
      const decision: PolicyDecision = {
        verdict: 'HOLD',
        reasons: [
          {
            rule: 'pin_required',
            detail: `Approving ${formatINR(quote.total)} needs the owner's PIN (above ${formatINR(pinThreshold(deps))}).`,
          },
        ],
        evaluatedAt: now,
      };
      return {
        decision,
        placed: false,
        requote: false,
        needsPin: true,
        gateLine: gateLine({ decision, quote, payment }),
      };
    }
    await requirePin(deps, memberId, factor);
  }

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
    if (res.replayed) {
      // The quote was already placed (double tap): this approval paid for nothing, so it must not stay live.
      await deps.store.consumeApproval(approval.id, now);
      approval.consumedAt = now;
    }
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
    const pin = optString(o, 'pin', 16);
    return approveQuote(deps, reqString(o, 'quoteHash', 128), memberOf(req), pin !== undefined ? { pin } : {});
  });
}
