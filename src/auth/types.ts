/**
 * Web identity records (docs/WEB_API.md "Identity" and "PIN"): passkeys, browser sessions, one-time setup codes,
 * the owner's approval PIN, security events, and cart rejections. Persistence shapes only; the rules live in
 * src/auth/*.ts. Secrets are never stored in plaintext: session tokens and setup codes as sha256 hex, the PIN as
 * scrypt.
 */
import type { ISODateTime, Member, PolicyDecision, Quote } from '../core/types.js';

/** A registered WebAuthn credential (passkey). */
export interface PasskeyRecord {
  /** Credential id, base64url, exactly as the authenticator reported it. */
  id: string;
  memberId: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType?: string;
  backedUp?: boolean;
  createdAt: ISODateTime;
  lastUsedAt?: ISODateTime;
}

/** A signed-in browser. The cookie carries the opaque token; only sha256(token) is kept. */
export interface WebSessionRecord {
  id: string;
  memberId: string;
  householdId: string;
  tokenHash: string;
  createdAt: ISODateTime;
  lastSeenAt: ISODateTime;
  /** Sliding: moved to now + 30 days on use. */
  expiresAt: ISODateTime;
  revokedAt?: ISODateTime;
}

/** A one-time passkey setup link (`/setup/<code>`). Only sha256(code) is kept. */
export interface SetupCodeRecord {
  id: string;
  memberId: string;
  householdId: string;
  codeHash: string;
  /** The owner who created it (absent when issued from the VPS shell). */
  createdBy?: string;
  createdAt: ISODateTime;
  expiresAt: ISODateTime;
  usedAt?: ISODateTime;
  /** Set when a newer link for the same member replaced it. */
  revokedAt?: ISODateTime;
}

/** The approval PIN of one member (owners). Lockout state lives with it. */
export interface PinRecord {
  memberId: string;
  householdId: string;
  /** `scrypt$N$r$p$<salt b64>$<hash b64>` */
  hash: string;
  setAt: ISODateTime;
  /** Wrong attempts in the last 24 h (pruned on write). */
  failures: ISODateTime[];
  /** Wrong attempts since the last success or the last 15-minute lock. */
  consecutive: number;
  /** 5 consecutive wrong PINs → PIN approvals disabled until then. */
  lockedUntil?: ISODateTime;
  /** 10 wrong PINs within 24 h → disabled until reset with a fresh passkey assertion. */
  hardLockedAt?: ISODateTime;
}

export type SecurityEventKind =
  | 'pin_set'
  | 'pin_reset'
  | 'pin_locked'
  | 'pin_hard_locked'
  | 'passkey_registered'
  | 'setup_link_created';

/** Append-only audit line (the "event recorded in the ledger" of WEB_API.md). Never carries PIN material. */
export interface SecurityEvent {
  id: string;
  householdId: string;
  memberId: string;
  kind: SecurityEventKind;
  at: ISODateTime;
  detail?: Record<string, string | number | boolean>;
}

/** A held cart someone rejected. A newer quote of the same hash (re-quoted later) is a new cart. */
export interface QuoteRejection {
  id: string;
  householdId: string;
  quoteHash: string;
  memberId: string;
  rejectedAt: ISODateTime;
}

/** One gate evaluation as the carts view needs it. */
export interface GateDecisionRow {
  quoteHash: string;
  memberId: string;
  placeId: string;
  decision: Pick<PolicyDecision, 'verdict' | 'reasons' | 'evaluatedAt'>;
}

/** Raw material for GET /api/carts (src/api/carts.ts decides what is "held"). */
export interface GateActivity {
  decisions: GateDecisionRow[];
  /** The stored (newest) quote per hash that appears in `decisions`. */
  quotes: Quote[];
  /** Orders placed for those hashes (not failed/cancelled). */
  placed: { quoteHash: string; placedAt: ISODateTime }[];
  rejections: { quoteHash: string; rejectedAt: ISODateTime }[];
}

/**
 * Persistence for web identity. MemoryStore and DbStore implement it as part of Store. Implementations append and
 * look up; they never decide (expiry, lockout and role rules are in src/auth).
 */
export interface IdentityStore {
  /**
   * Insert or replace a member (name, role, channels, phones, defaultPlaceId). Throws BazaarError('PHONE_TAKEN')
   * when one of its phones belongs to another member of the same household.
   */
  saveMember(member: Member): Promise<void>;

  listPasskeys(memberId: string): Promise<PasskeyRecord[]>;
  findPasskey(credentialId: string): Promise<PasskeyRecord | undefined>;
  savePasskey(passkey: PasskeyRecord): Promise<void>;
  updatePasskeyCounter(credentialId: string, counter: number, at: ISODateTime): Promise<void>;
  /** Member ids of the household that have at least one passkey. */
  passkeyMemberIds(householdId: string): Promise<string[]>;

  createSession(session: WebSessionRecord): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<WebSessionRecord | undefined>;
  touchSession(id: string, lastSeenAt: ISODateTime, expiresAt: ISODateTime): Promise<void>;
  revokeSession(id: string, at: ISODateTime): Promise<void>;

  /** Store a new setup code and revoke the member's earlier unused ones. */
  createSetupCode(code: SetupCodeRecord): Promise<void>;
  findSetupCode(codeHash: string): Promise<SetupCodeRecord | undefined>;
  /** Atomically mark the code used; false if it was already used or revoked (single use). */
  consumeSetupCode(id: string, at: ISODateTime): Promise<boolean>;

  getPin(memberId: string): Promise<PinRecord | undefined>;
  savePin(pin: PinRecord): Promise<void>;
  recordSecurityEvent(event: SecurityEvent): Promise<void>;

  saveRejection(rejection: QuoteRejection): Promise<void>;
  /** Gate decisions evaluated at or after `since`, with their quotes, placements and rejections. */
  loadGateActivity(householdId: string, since: ISODateTime): Promise<GateActivity>;
}
