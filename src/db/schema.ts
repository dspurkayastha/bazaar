/**
 * Drizzle schema. Shapes mirror src/core/types.ts; jsonb columns are typed with the core types.
 * Money columns are integer paise. Timestamps are timestamptz returned as ISO strings.
 * The ledger (ledger_orders, ledger_lines, policy_decisions) is append-only by convention.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  Approval,
  ItemCategory,
  ItemDefault,
  Member,
  MemberRole,
  PolicyConfig,
  PolicyDecision,
  PolicyVerdict,
  Profile,
  Quote,
  Serviceability,
  ShopRequest,
  ShopResult,
  SupplierId,
} from '../core/types.js';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const createdAt = () => ts('created_at').notNull().defaultNow();

export const households = pgTable('households', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** PolicyConfig; amounts in paise. Changes require owner confirmation (PRD). */
  policy: jsonb('policy').$type<PolicyConfig>().notNull(),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  createdAt: createdAt(),
});

export const members = pgTable(
  'members',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    role: text('role').$type<MemberRole>().notNull(),
    channels: jsonb('channels').$type<Member['channels']>().notNull().default([]),
    defaultPlaceId: text('default_place_id'),
    createdAt: createdAt(),
  },
  (t) => [index('members_household_idx').on(t.householdId)],
);

/**
 * Per-member API credentials. Only sha256(token) is stored (hex); the `mtk_...` plaintext is shown once at issue.
 * Issuing a new credential revokes the member's previous ones (rotation); revoked rows are kept for audit.
 */
export const memberCredentials = pgTable(
  'member_credentials',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('member_credentials_member_idx').on(t.memberId)],
);

/** Member phone numbers (E.164). One row per number; a number belongs to at most one member of a household. */
export const memberPhones = pgTable(
  'member_phones',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.phone] }), index('member_phones_member_idx').on(t.memberId)],
);

export const places = pgTable(
  'places',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** Stable slug (core/identity.ts slugify), unique per household. */
    key: text('key').notNull(),
    nickname: text('nickname').notNull(),
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
    canonicalAddress: text('canonical_address').notNull(),
    city: text('city').notNull(),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    supplierAddressIds: jsonb('supplier_address_ids')
      .$type<Partial<Record<SupplierId, string>>>()
      .notNull()
      .default({}),
    serviceability: jsonb('serviceability').$type<Serviceability[]>().notNull().default([]),
    trusted: boolean('trusted').notNull().default(false),
    profileOverlay: jsonb('profile_overlay').$type<Partial<Profile>>(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('places_household_nickname_uq').on(t.householdId, t.nickname),
    uniqueIndex('places_household_key_uq').on(t.householdId, t.key),
    // At most one default place per household.
    uniqueIndex('places_one_default_uq')
      .on(t.householdId)
      .where(sql`${t.isDefault} = true`),
  ],
);

/** Profile minus `defaults` (which live in item_defaults so they can be learned and edited row by row). */
export type StoredProfile = Omit<Profile, 'defaults' | 'householdId'>;

export const profiles = pgTable('profiles', {
  householdId: text('household_id')
    .primaryKey()
    .references(() => households.id, { onDelete: 'cascade' }),
  profile: jsonb('profile').$type<StoredProfile>().notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const itemDefaults = pgTable(
  'item_defaults',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
    brand: text('brand'),
    product: text('product'),
    size: text('size'),
    quantityPerHead: real('quantity_per_head'),
    category: text('category').$type<ItemCategory>().notNull(),
    neverSubstitute: boolean('never_substitute').notNull().default(false),
    supplierHints: jsonb('supplier_hints').$type<ItemDefault['supplierHints']>(),
    origin: text('origin').$type<ItemDefault['origin']>().notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('item_defaults_household_key_uq').on(t.householdId, t.key)],
);

export const quotes = pgTable(
  'quotes',
  {
    id: text('id').primaryKey(),
    hash: text('hash').notNull().unique(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    requestId: text('request_id'),
    supplierId: text('supplier_id').$type<SupplierId>().notNull(),
    placeId: text('place_id')
      .notNull()
      .references(() => places.id),
    supplierAddressId: text('supplier_address_id').notNull(),
    total: integer('total').notNull(),
    /** The full raw Quote as returned by the supplier adapter (never a sanitised copy). */
    quote: jsonb('quote').$type<Quote>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('quotes_household_idx').on(t.householdId, t.createdAt)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    quoteHash: text('quote_hash').notNull(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    /** Place and supplier the owner approved; required for line-bound approvals (engine refuses without). */
    placeId: text('place_id').references(() => places.id),
    supplierId: text('supplier_id').$type<SupplierId>(),
    conditions: jsonb('conditions').$type<NonNullable<Approval['conditions']>>(),
    /** Set when the gate used this approval to pay; an approval pays at most once. */
    consumedAt: ts('consumed_at'),
  },
  (t) => [index('approvals_quote_hash_idx').on(t.quoteHash)],
);

export const ledgerOrders = pgTable(
  'ledger_orders',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    supplierId: text('supplier_id').$type<SupplierId>().notNull(),
    supplierOrderId: text('supplier_order_id').notNull(),
    placedAt: ts('placed_at').notNull(),
    placeId: text('place_id').references(() => places.id),
    supplierAddressId: text('supplier_address_id'),
    memberId: text('member_id').references(() => members.id),
    fees: jsonb('fees').$type<{ label: string; amount: number }[]>().notNull().default([]),
    total: integer('total').notNull(),
    status: text('status').notNull(),
    quoteHash: text('quote_hash'),
    decision: jsonb('decision').$type<PolicyDecision>(),
    /** Approval used to pay (null for unattended gate orders and for orders placed outside Bazaar). */
    approvalId: text('approval_id'),
    /** Placed by the gate on PAY without an approval; only these count toward the daily cap. */
    unattended: boolean('unattended').notNull().default(false),
    raw: jsonb('raw'),
    ingestedAt: ts('ingested_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ledger_orders_supplier_order_uq').on(t.supplierId, t.supplierOrderId),
    index('ledger_orders_household_placed_idx').on(t.householdId, t.placedAt),
  ],
);

export const ledgerLines = pgTable(
  'ledger_lines',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => ledgerOrders.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    variantId: text('variant_id'),
    quantity: integer('quantity').notNull(),
    unitPrice: integer('unit_price').notNull(),
    lineTotal: integer('line_total').notNull(),
    category: text('category').$type<ItemCategory>(),
    addedBy: text('added_by'),
    itemKey: text('item_key'),
  },
  (t) => [index('ledger_lines_order_idx').on(t.orderId), index('ledger_lines_item_key_idx').on(t.itemKey)],
);

/** Every gate evaluation, PAY or not, with the quote hash and the rules that fired. */
export const policyDecisions = pgTable(
  'policy_decisions',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    quoteHash: text('quote_hash').notNull(),
    liveCartHash: text('live_cart_hash').notNull(),
    placeId: text('place_id').references(() => places.id),
    memberId: text('member_id').references(() => members.id),
    verdict: text('verdict').$type<PolicyVerdict>().notNull(),
    reasons: jsonb('reasons').$type<PolicyDecision['reasons']>().notNull(),
    approvalId: text('approval_id'),
    /** True when an approval lifted a HOLD for this decision. */
    approvalUsed: boolean('approval_used').notNull().default(false),
    unattended: boolean('unattended').notNull().default(false),
    evaluatedAt: ts('evaluated_at').notNull(),
    /** Supplier order id when the gate went on to place. */
    supplierOrderId: text('supplier_order_id'),
  },
  (t) => [index('policy_decisions_quote_hash_idx').on(t.quoteHash)],
);

export const requests = pgTable(
  'requests',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id),
    channel: text('channel').$type<ShopRequest['channel']>().notNull(),
    text: text('text').notNull(),
    receivedAt: ts('received_at').notNull(),
    context: jsonb('context').$type<NonNullable<ShopRequest['context']>>(),
    result: jsonb('result').$type<ShopResult>(),
  },
  (t) => [index('requests_household_received_idx').on(t.householdId, t.receivedAt)],
);

/** Supplier OAuth tokens, AES-256-GCM encrypted with TOKEN_ENC_KEY. Never stored in plaintext. */
export const supplierTokens = pgTable(
  'supplier_tokens',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    supplierId: text('supplier_id').$type<SupplierId>().notNull(),
    /** base64(iv | authTag | ciphertext) */
    blob: text('blob').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    expiresAt: ts('expires_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.supplierId] })],
);

// ---------- web identity (docs/WEB_API.md) ----------

/** WebAuthn credentials (passkeys). The id is the credential id (base64url). */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transports: jsonb('transports').$type<string[]>().notNull().default([]),
    deviceType: text('device_type'),
    backedUp: boolean('backed_up'),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [index('webauthn_credentials_member_idx').on(t.memberId)],
);

/** Browser sessions (`bz_session` cookie). Only sha256(token) is stored. */
export const webSessions = pgTable(
  'web_sessions',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: ts('created_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('web_sessions_member_idx').on(t.memberId)],
);

/** One-time passkey setup links. Only sha256(code) is stored. */
export const setupCodes = pgTable(
  'setup_codes',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull().unique(),
    createdBy: text('created_by'),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('setup_codes_member_idx').on(t.memberId)],
);

/** Approval PINs (scrypt) and their lockout state. Never logged, never returned. */
export const memberPins = pgTable('member_pins', {
  memberId: text('member_id')
    .primaryKey()
    .references(() => members.id, { onDelete: 'cascade' }),
  householdId: text('household_id')
    .notNull()
    .references(() => households.id, { onDelete: 'cascade' }),
  hash: text('hash').notNull(),
  setAt: ts('set_at').notNull(),
  failures: jsonb('failures').$type<string[]>().notNull().default([]),
  consecutive: integer('consecutive').notNull().default(0),
  lockedUntil: ts('locked_until'),
  hardLockedAt: ts('hard_locked_at'),
});

/** Security audit trail: PIN set/reset/lockouts, passkey registrations, setup links. Append-only. */
export const securityEvents = pgTable(
  'security_events',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    at: ts('at').notNull(),
    detail: jsonb('detail').$type<Record<string, string | number | boolean>>(),
  },
  (t) => [index('security_events_household_idx').on(t.householdId, t.at)],
);

/** Held carts someone rejected (POST /api/carts/:quoteHash/reject). */
export const quoteRejections = pgTable(
  'quote_rejections',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    quoteHash: text('quote_hash').notNull(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    rejectedAt: ts('rejected_at').notNull(),
  },
  (t) => [index('quote_rejections_hash_idx').on(t.quoteHash)],
);
