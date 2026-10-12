/**
 * Bazaar core contracts. Every builder codes against these. Change only via docs/CONTRACTS.md.
 * Money is integer paise everywhere (₹1,123.00 = 112300). Never floats.
 */

export type Paise = number; // integer
export type ISODate = string; // 'YYYY-MM-DD'
export type ISODateTime = string; // RFC3339

// ---------- Household ----------

export type MemberRole = 'owner' | 'adder' | 'viewer' | 'dependant';

export interface Member {
  id: string;
  householdId: string;
  name: string;
  role: MemberRole;
  /** e.g. WhatsApp number in E.164, Siri device id. `trusted` (owner channels only): see PolicyContext.webhook */
  channels: { kind: 'whatsapp' | 'siri' | 'web'; address: string; trusted?: boolean }[];
  /** For dependants: the place their orders go to by default */
  defaultPlaceId?: string;
}

export type SupplierId = 'instamart' | 'swiggy_food' | 'zomato' | 'blinkit' | 'zepto' | 'kirana';

export interface Serviceability {
  supplierId: SupplierId;
  serviceable: boolean;
  checkedAt: ISODateTime;
  lastEtaMinutes?: number;
  lastDeliveryFee?: Paise;
}

export interface Place {
  id: string;
  householdId: string;
  /** Primary spoken name, e.g. "home" */
  nickname: string;
  aliases: string[]; // "the hospital", "SCC", "work"
  canonicalAddress: string;
  city: string;
  lat?: number;
  lng?: number;
  /** Supplier-side address ids, e.g. { instamart: 'd4qog5...' } */
  supplierAddressIds: Partial<Record<SupplierId, string>>;
  serviceability: Serviceability[];
  /** Unattended pay allowed only to trusted places */
  trusted: boolean;
  /** Overrides to the household profile when shopping for this place (dependants) */
  profileOverlay?: Partial<Profile>;
  isDefault: boolean;
}

export type ItemCategory =
  | 'grocery' | 'dairy' | 'produce' | 'meat' | 'snacks' | 'drinks' | 'household'
  | 'pet' | 'baby' | 'personal_care' | 'medicine' | 'alcohol' | 'tobacco'
  | 'electronics' | 'appliances' | 'gift_card' | 'cooked_food' | 'other';

export interface ItemDefault {
  /** Normalised item class, e.g. "milk", "curd", "dettol" */
  key: string;
  aliases: string[]; // "dudh", "doi"
  brand?: string;
  /** Product line within the brand, e.g. "American Nuts", "Lactose Free" */
  product?: string;
  size?: string; // "250 ml x 4"
  quantityPerHead?: number; // scaled by people count
  category: ItemCategory;
  neverSubstitute?: boolean; // meat cuts etc.
  /** Supplier-specific hints learned from the ledger */
  supplierHints?: Partial<Record<SupplierId, { spinId?: string; skuId?: string; lastPrice?: Paise; lastSeen?: ISODateTime }>>;
  origin: 'stated' | 'learned'; // shown to the user ("from your last 4 orders")
}

export interface RecipeTemplate {
  name: string; // "biryani"
  aliases: string[];
  servesDefault: number;
  items: { key: string; quantityPerHead?: number; optional?: boolean }[];
}

export interface Profile {
  householdId: string;
  peopleDefault: number;
  pantryAssumed: string[]; // "oil", "salt", "onions"
  defaults: ItemDefault[];
  recipes: RecipeTemplate[];
  usualLists: { name: string; items: { key: string; quantity: number }[] }[];
  languageHints: string[]; // "bn", "en", "hi"
}

export interface Household {
  id: string;
  name: string;
  members: Member[];
  places: Place[];
  profile: Profile;
  policy: PolicyConfig;
}

// ---------- Supplier contract ----------

export interface SupplierProduct {
  supplierId: SupplierId;
  productId: string;
  name: string;
  brand?: string;
  category: ItemCategory;
  variants: SupplierVariant[];
}

export interface SupplierVariant {
  variantId: string; // spinId for Instamart
  skuId?: string;
  label: string; // "250 ml x 4"
  mrp: Paise;
  price: Paise;
  unitPrice?: string; // "10.4/100 ml"
  inStock: boolean;
  maxQuantity?: number;
  etaMinutes?: number;
}

export interface CartLine {
  variantId: string;
  skuId?: string;
  quantity: number;
  /** Why this line exists: user ask, recipe, default, member add */
  reason: { kind: 'asked' | 'recipe' | 'default' | 'member_add' | 'usual'; by?: string; itemKey?: string };
}

export interface QuoteLine {
  /** Normalised item class when known (bridges to profile defaults and quantityHistory) */
  itemKey?: string;
  variantId: string;
  skuId?: string;
  name: string;
  label: string;
  quantity: number;
  unitPrice: Paise;
  lineTotal: Paise;
  category: ItemCategory;
}

export interface Quote {
  id: string;
  /** sha256 over supplierId, placeId, sorted lines (variantId, qty, unitPrice), fees, total */
  hash: string;
  supplierId: SupplierId;
  placeId: string;
  supplierAddressId: string;
  lines: QuoteLine[];
  itemTotal: Paise;
  fees: { label: string; amount: Paise }[];
  total: Paise;
  etaMinutes?: number;
  createdAt: ISODateTime;
  /** Items the request asked for that this supplier could not supply */
  unavailable: { itemKey: string; reason: string }[];
}

export type PaymentMethod =
  | { kind: 'cod' }
  | { kind: 'upi'; intentApp: string }
  | { kind: 'wallet' };

export interface PlacedOrder {
  supplierId: SupplierId;
  supplierOrderId: string;
  quoteId: string;
  status: 'pending_payment' | 'placed' | 'failed';
  paymentRef?: string; // paasId
  placedAt: ISODateTime;
}

export interface Supplier {
  id: SupplierId;
  /** Does this supplier deliver to this place? Cheap; cached by the caller. */
  checkServiceability(place: Place): Promise<Serviceability>;
  search(query: string, place: Place): Promise<SupplierProduct[]>;
  /** Frequently/recently ordered items at a place (may be empty for suppliers without it) */
  goToItems(place: Place): Promise<SupplierProduct[]>;
  /** Replace the supplier-side cart and return a priced, hashed quote. */
  quote(lines: CartLine[], place: Place): Promise<Quote>;
  /** Re-read the live supplier cart as a quote (for integrity checks). */
  readCart(place: Place): Promise<Quote>;
  clearCart(): Promise<void>;
  /** Place the order. MUST only be called by the policy gate wrapper, never directly by the agent. */
  place(quote: Quote, payment: PaymentMethod): Promise<PlacedOrder>;
  track(order: PlacedOrder, place: Place): Promise<{ status: string; etaMinutes?: number; raw: unknown }>;
  /** Past orders for ledger ingest */
  orders(opts?: { count?: number; activeOnly?: boolean }): Promise<LedgerOrderInput[]>;
}

// ---------- Policy ----------

export interface PolicyConfig {
  perOrderUnattendedMax: Paise; // 50000
  dailyUnattendedMax: Paise; // 150000
  monthlyMax: Paise; // 800000
  unattendedCategories: ItemCategory[];
  blockedCategories: ItemCategory[];
  blockedUnitPriceOver: Paise; // 300000
  quantityBoundMultiplier: number; // 2 × 90-day max
}

export interface Approval {
  id: string;
  quoteHash: string;
  memberId: string; // must be an owner
  createdAt: ISODateTime;
  expiresAt: ISODateTime;
  /** Set when the approval has been used to place an order; single-use */
  consumedAt?: ISODateTime;
  /**
   * The place and supplier the owner approved. REQUIRED for line-bound approvals (the engine refuses one without
   * them, or whose place/supplier differ from the quote's); checked when present on hash-bound ones (the hash
   * already covers both).
   */
  placeId?: string;
  supplierId?: SupplierId;
  /**
   * Scheduled orders: a conditional approval binds to the LINES (sorted variantId:qty) rather than the
   * full hash, and covers any fire-time quote with the same lines whose total <= maxTotal and whose
   * items are in stock. `lineHash` is sha256 of the sorted lines; see core/hash.ts.
   * A line-bound approval covers requests by the approving owner (`memberId`) only, plus the members listed
   * in `forMembers`.
   */
  conditions?: {
    lineHash?: string;
    inStock?: boolean;
    maxTotal?: Paise;
    notBefore?: ISODateTime;
    forMembers?: string[];
  };
}

export interface PolicyContext {
  household: Household;
  place: Place;
  quote: Quote;
  /** The live cart re-read immediately before pay; must equal quote */
  liveCart: Quote;
  approvals: Approval[];
  requestingMember: Member;
  spendToday: Paise;
  spendThisMonth: Paise;
  /** itemKey → max quantity bought in one order in the last 90 days */
  quantityHistory: Record<string, number>;
  now: ISODateTime;
  /**
   * Set when the request arrived through a signed channel webhook (WhatsApp) rather than a member's own bearer
   * token. Approvals never apply to such a request, and it is HELD (channel_untrusted) unless `trusted`
   * (an owner's channel marked `trusted` in Member.channels).
   */
  webhook?: { channel: 'whatsapp' | 'siri' | 'web'; trusted: boolean };
}

export type PolicyVerdict = 'PAY' | 'HOLD' | 'BLOCK';

export interface PolicyDecision {
  verdict: PolicyVerdict;
  reasons: { rule: string; detail: string }[];
  /** Which approval satisfied the gate, if any */
  approvalId?: string;
  evaluatedAt: ISODateTime;
}

// ---------- Ledger ----------

export interface LedgerOrderInput {
  supplierId: SupplierId;
  supplierOrderId: string;
  placedAt: ISODateTime;
  placeId?: string;
  supplierAddressId?: string;
  lines: { name: string; variantId?: string; quantity: number; unitPrice: Paise; lineTotal: Paise; category?: ItemCategory; addedBy?: string; itemKey?: string }[];
  fees: { label: string; amount: Paise }[];
  total: Paise;
  status: string;
  quoteHash?: string;
  decision?: PolicyDecision;
  raw?: unknown;
}

// ---------- Requests ----------

export interface ShopRequest {
  id: string;
  householdId: string;
  memberId: string;
  /** 'voice': one turn of the iPhone app's voice session (/voice, docs/VOICE_PROTOCOL.md) */
  channel: 'siri' | 'whatsapp' | 'web' | 'voice';
  text: string; // transcript
  receivedAt: ISODateTime;
  /** Optional client context for place inference */
  context?: { lat?: number; lng?: number; calendarPlaceId?: string };
}

export interface ShopResult {
  requestId: string;
  placeId: string;
  placeReason: 'explicit' | 'member' | 'context' | 'default';
  quotes: Quote[]; // one per supplier that could serve
  chosen?: Quote;
  decision?: PolicyDecision;
  removedFromCart: { name: string; quantity: number }[];
  questions: string[]; // should be empty most of the time
  summary: string; // one short paragraph for the user
}
