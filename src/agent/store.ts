/**
 * Persistence the agent loop and the API need, behind one interface so tests run in memory and production runs
 * on Postgres (src/db/store.ts). Implementations append and look up; they never decide anything.
 */
import type {
  Approval,
  Household,
  ISODateTime,
  LedgerOrderInput,
  Place,
  Quote,
  Serviceability,
  ShopRequest,
  ShopResult,
} from '../core/types.js';
import type { DecisionRecorder } from '../policy/gate.js';
import type { GateLock } from '../policy/lock.js';
import type { SpendRow } from '../policy/spend.js';

export interface Store {
  /** Records every gate evaluation and every placed order (and consumes the approval that paid). */
  readonly recorder: DecisionRecorder;
  /** Serialises gate runs per household (Postgres: advisory lock). Absent → the process-wide in-memory lock. */
  readonly gateLock?: GateLock;

  loadHousehold(householdId: string): Promise<Household>;
  /** Resolve a channel address (WhatsApp number, device id) to a member. */
  findMemberByChannel(
    kind: 'whatsapp' | 'siri' | 'web',
    address: string,
  ): Promise<{ householdId: string; memberId: string } | undefined>;

  /**
   * Resolve a member credential (sha256 hex of the member's bearer token) to its member. Revoked credentials and
   * unknown hashes resolve to undefined.
   */
  findMemberByTokenHash(tokenHash: string): Promise<{ householdId: string; memberId: string } | undefined>;
  /** Install a new credential hash for the member and revoke every previous one (issue = rotate). */
  rotateMemberCredential(memberId: string, tokenHash: string): Promise<void>;

  /** Insert or replace a place (all fields). */
  savePlace(place: Place): Promise<void>;
  saveServiceability(placeId: string, records: Serviceability[]): Promise<void>;

  saveRequest(request: ShopRequest): Promise<void>;
  saveResult(result: ShopResult): Promise<void>;

  /** Store the raw (never sanitised) quote so an approval can later be tied to its hash. */
  saveQuote(householdId: string, quote: Quote, requestId?: string): Promise<void>;
  getQuote(hash: string): Promise<{ householdId: string; quote: Quote } | undefined>;

  saveApproval(approval: Approval): Promise<void>;
  /** Mark an approval used (no-op if already consumed). Used when a repeat /approve resolves as a replay. */
  consumeApproval(approvalId: string, at: ISODateTime): Promise<void>;
  /** Unconsumed approvals that could cover this quote (exact hash, or line-bound). */
  loadApprovals(quote: Quote): Promise<Approval[]>;

  /** Ledger rows for the spend caps, from `since` (inclusive) onward. */
  loadSpendRows(householdId: string, since: ISODateTime): Promise<SpendRow[]>;
  /** itemKey → max quantity bought in one order in the last 90 days. */
  loadQuantityHistory(householdId: string, now: ISODateTime): Promise<Record<string, number>>;
  /** Ledger orders for reporting. */
  loadLedgerOrders(householdId: string, since?: ISODateTime): Promise<LedgerOrderInput[]>;
}
