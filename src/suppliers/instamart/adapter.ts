/**
 * Instamart Supplier adapter: maps docs/instamart-tools.json onto the Supplier contract.
 *
 * - quote()  = update_cart (replace) with selectedAddressId, then get_cart -> bill -> hash.
 * - readCart() = get_cart -> the same parser -> the same hash (core/hash.ts).
 * - place()  = checkout (never retried, confirmDuplicate never set); UPI: one check_payment_status then
 *              confirm_order on SUCCESS/PAID.
 * - Every supplier-provided string is run through core/sanitise.ts before it leaves this module. Ids (spinId,
 *   skuId, orderId, paasId, payment method ids) are passed through byte-for-byte: they are data the server must
 *   get back unchanged, not text for the model.
 *
 * The adapter takes an injected `callTool` so tests never touch the MCP client or the network.
 */
import { QuoteMismatch, SupplierError } from '../../core/errors.js';
import { quoteHash } from '../../core/hash.js';
import { newId } from '../../core/ids.js';
import { parseRupeesRounded } from '../../core/money.js';
import { sanitiseField, sanitiseText } from '../../core/sanitise.js';
import type { SanitiseLog } from '../../core/sanitise.js';
import type {
  CartLine,
  LedgerOrderInput,
  Paise,
  PaymentMethod,
  Place,
  PlacedOrder,
  Quote,
  QuoteLine,
  Serviceability,
  Supplier,
  SupplierProduct,
  SupplierVariant,
} from '../../core/types.js';
import { classify } from './category.js';
import type { CallTool } from './mcp.js';

const ID = 'instamart' as const;

export interface InstamartAdapterOptions {
  callTool: CallTool;
  now?: () => string;
  /** Records what sanitise stripped (optional). */
  log?: SanitiseLog;
}

/** A saved supplier address, as offered for one-tap import into a place (GET /api/household/supplier-addresses). */
export interface SupplierAddress {
  /** Byte-for-byte as the supplier sent it: becomes Place.supplierAddressIds.instamart. */
  id: string;
  /** e.g. "Home", "Work" (sanitised). */
  tag: string;
  /** e.g. "Friends & Family" (sanitised). */
  category: string;
  /** Sanitised address line. */
  addressLine: string;
}

/** Suppliers that can list the account's saved addresses. */
export interface AddressBook {
  getAddresses(): Promise<SupplierAddress[]>;
}

export function hasAddressBook(s: unknown): s is AddressBook {
  return typeof (s as Partial<AddressBook> | null)?.getAddresses === 'function';
}

const MAX_ADDRESS_PAGES = 5;

export interface PaymentMethodOption {
  /** Byte-for-byte as the server sent it; pass to checkout as intentApp. */
  id: string;
  name?: string;
  type?: string;
}

export interface PaymentOptions {
  mobile: PaymentMethodOption[];
  desktop: PaymentMethodOption[];
  all: PaymentMethodOption[];
  /** True when the server offers cash on delivery (cod key present and not explicitly disabled). */
  codAvailable: boolean;
  raw: unknown;
}

// ---------- small JSON helpers ----------

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function pick(o: Json, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/**
 * Rupees (number or "₹1,234.50") -> paise by string decomposition only (core/money.ts parseRupeesRounded):
 * no float multiplication anywhere; a third decimal rounds half up. Unparseable -> undefined.
 */
export function toPaise(v: unknown): Paise | undefined {
  if (typeof v === 'number' || typeof v === 'string') {
    if (typeof v === 'string' && /^(free|nil|-|—)$/i.test(v.trim())) return 0;
    try {
      return parseRupeesRounded(v);
    } catch {
      return undefined;
    }
  }
  if (isObj(v)) return toPaise(pick(v, 'value', 'amount', 'price', 'offerPrice'));
  return undefined;
}

/** Recursively sanitise every string leaf. Used for `raw` payloads handed back to callers. */
function cleanDeep(v: unknown): unknown {
  if (typeof v === 'string') return sanitiseText(v).text;
  if (Array.isArray(v)) return v.map(cleanDeep);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x)]));
  return v;
}

function etaMinutes(sla: unknown): number | undefined {
  if (!isObj(sla)) return undefined;
  const value = num(sla.value);
  if (value === undefined) return undefined;
  const unit = (str(sla.unit) ?? 'MINS').toLowerCase();
  if (unit.startsWith('h')) return Math.round(value * 60);
  if (unit.startsWith('s')) return Math.max(1, Math.round(value / 60));
  return Math.round(value);
}

// ---------- product mapping ----------

export function mapProducts(raw: unknown, log?: SanitiseLog): SupplierProduct[] {
  const products = isObj(raw) ? arr(raw.products) : arr(raw);
  const out: SupplierProduct[] = [];
  for (const p of products) {
    if (!isObj(p)) continue;
    const productId = str(pick(p, 'productId', 'parentProductId'));
    const rawName = str(p.displayName) ?? str(p.name);
    if (!productId || !rawName) continue;
    const brand = str(p.brand);
    const productInStock = p.inStock !== false && p.isAvail !== false;
    const variants: SupplierVariant[] = [];
    for (const vv of arr(p.variations)) {
      if (!isObj(vv)) continue;
      const spinId = str(vv.spinId);
      if (!spinId) continue;
      const price = isObj(vv.price) ? vv.price : {};
      const mrp = toPaise(price.mrp);
      const offer = toPaise(price.offerPrice) ?? mrp;
      if (offer === undefined) continue;
      const stockFlag = vv.isInStockAndAvailable;
      const label = str(vv.quantityDescription) ?? str(vv.displayName) ?? '';
      const unit = str(price.unitLevelPrice);
      const maxQuantity = num(vv.maxQuantity);
      const eta = etaMinutes(vv.sla);
      const skuId = str(vv.skuId);
      const base = `${ID}:product:${productId}.variant:${spinId}`;
      variants.push({
        variantId: spinId,
        ...(skuId !== undefined ? { skuId } : {}),
        label: sanitiseField(label, `${base}.label`, log),
        mrp: mrp ?? offer,
        price: offer,
        ...(unit !== undefined ? { unitPrice: sanitiseField(unit, `${base}.unitPrice`, log) } : {}),
        inStock: (typeof stockFlag === 'boolean' ? stockFlag : true) && productInStock,
        ...(maxQuantity !== undefined ? { maxQuantity } : {}),
        ...(eta !== undefined ? { etaMinutes: eta } : {}),
      });
    }
    if (variants.length === 0) continue;
    const base = `${ID}:product:${productId}`;
    const name = sanitiseField(rawName, `${base}.name`, log, '(name withheld)');
    // classify on the raw text: stripping an injected sentence must not change the category
    out.push({
      supplierId: ID,
      productId,
      name,
      ...(brand !== undefined ? { brand: sanitiseField(brand, `${base}.brand`, log) } : {}),
      category: classify(rawName, brand),
      variants,
    });
  }
  return out;
}

// ---------- bill parsing ----------

export interface BillRow {
  label: string;
  amount: Paise;
}

const SAVINGS_RE = /saving|saved|you save|total discount on mrp/i;
const TOTAL_RE =
  /\bto\s*pay\b|grand\s*total|amount\s*payable|total\s*payable|net\s*payable|^total$|^bill\s*total$|^order\s*total$/i;
const ITEM_TOTAL_RE = /^(?:item|items|cart)\s*(?:total|value)$|^sub\s*total$|^item\s*total/i;

function splitCamel(k: string): string {
  return k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
}

function rowsFromBill(
  bill: unknown,
  out: { label: string; value: unknown }[] = [],
  depth = 0,
): { label: string; value: unknown }[] {
  if (depth > 3) return out;
  if (Array.isArray(bill)) {
    for (const r of bill) {
      if (!isObj(r)) continue;
      const label = str(pick(r, 'label', 'title', 'name', 'key', 'displayName', 'text'));
      const value = pick(r, 'value', 'amount', 'price', 'displayValue');
      if (label !== undefined && value !== undefined) out.push({ label, value });
      else {
        for (const nested of Object.values(r)) if (Array.isArray(nested)) rowsFromBill(nested, out, depth + 1);
      }
    }
    return out;
  }
  if (isObj(bill)) {
    for (const [k, v] of Object.entries(bill)) {
      // A {label, value} row held directly under a key, e.g. billBreakdown.toPay = {label:"To Pay", value:"₹1396"}
      if (isObj(v) && str(pick(v, 'label', 'title')) !== undefined && pick(v, 'value', 'amount') !== undefined) {
        out.push({ label: str(pick(v, 'label', 'title')) as string, value: pick(v, 'value', 'amount') });
        continue;
      }
      if (Array.isArray(v)) rowsFromBill(v, out, depth + 1);
      else if (isObj(v) && toPaise(v) === undefined) rowsFromBill(v, out, depth + 1);
      else if (toPaise(v) !== undefined && !/^(currency|count|itemCount|totalItems)$|Id$/.test(k))
        out.push({ label: splitCamel(k), value: v });
    }
  }
  return out;
}

export function canonFeeLabel(raw: string): string {
  const l = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/small\s*cart|min(?:imum)?\s*cart|low\s*cart/.test(l)) return 'small_cart';
  if (/handling/.test(l)) return 'handling';
  if (/deliver/.test(l)) return 'delivery';
  if (/platform/.test(l)) return 'platform';
  if (/surge|rain|night|late/.test(l)) return 'surge';
  if (/gst|tax/.test(l)) return 'tax';
  if (/tip/.test(l)) return 'tip';
  return l.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'fee';
}

export interface ParsedBill {
  itemTotal?: Paise;
  total?: Paise;
  fees: { label: string; amount: Paise }[];
}

export function parseBill(billLike: unknown, log?: SanitiseLog): ParsedBill {
  const parsed: ParsedBill = { fees: [] };
  for (const row of rowsFromBill(billLike)) {
    const amount0 = toPaise(row.value);
    if (amount0 === undefined) continue;
    const label = sanitiseField(row.label.trim(), `${ID}:bill.label`, log, 'fee');
    if (SAVINGS_RE.test(label)) continue; // informational, not part of the amount payable
    const lower = label.toLowerCase();
    if (TOTAL_RE.test(lower)) parsed.total = amount0;
    else if (ITEM_TOTAL_RE.test(lower)) parsed.itemTotal = amount0;
    else {
      // "Discount: 20" is shown positive but reduces the bill
      const amount = /discount|coupon|promo|cashback|offer/.test(lower) && amount0 > 0 ? -amount0 : amount0;
      if (amount !== 0) parsed.fees.push({ label: canonFeeLabel(label), amount });
    }
  }
  return parsed;
}

// ---------- cart parsing ----------

interface CartParse {
  lines: QuoteLine[];
  unavailable: Quote['unavailable'];
  fees: { label: string; amount: Paise }[];
  itemTotal: Paise;
  total: Paise;
  etaMinutes?: number;
  /** The address the server cart is priced for, when get_cart says (it usually does). */
  addressId?: string;
}

function parseCart(raw: unknown, itemKeys: Map<string, string>, log?: SanitiseLog): CartParse {
  const parsed = parseCartBody(raw, itemKeys, log);
  const root = isObj(raw) ? raw : {};
  const cart = isObj(root.cart) ? root.cart : root;
  const details = isObj(cart.selectedAddressDetails) ? cart.selectedAddressDetails : {};
  const addressId =
    str(pick(cart, 'addressId', 'selectedAddressId', 'deliveryAddressId', 'selectedAddress')) ?? str(details.id);
  return addressId !== undefined ? { ...parsed, addressId } : parsed;
}

/**
 * Saved-address ids from get_addresses look like "<base>__<suffix>" while get_cart reports only "<base>"
 * (observed live, 12 Oct 2026). Compare on the base part.
 */
export function sameAddress(a: string, b: string): boolean {
  const base = (s: string) => s.split('__')[0] as string;
  return a === b || base(a) === base(b);
}

/** The server cart must be priced for the address we are about to pay to; otherwise it is not our quote. */
function assertCartAddress(parsed: CartParse, expected: string, op: string): void {
  if (parsed.addressId !== undefined && !sameAddress(parsed.addressId, expected)) {
    throw new QuoteMismatch(
      `address ${expected}`,
      `address ${parsed.addressId}`,
      `${op}: the server cart is for another delivery address; re-quote`,
    );
  }
}

function parseCartBody(raw: unknown, itemKeys: Map<string, string>, log?: SanitiseLog): CartParse {
  const root = isObj(raw) ? raw : {};
  const cart = isObj(root.cart) ? root.cart : root;
  const items = arr(pick(cart, 'items', 'cartItems', 'products'));
  const lines: QuoteLine[] = [];
  const unavailable: Quote['unavailable'] = [];

  for (const it of items) {
    if (!isObj(it)) continue;
    const spinId = str(it.spinId);
    const quantity = num(it.quantity);
    if (!spinId || quantity === undefined || !Number.isInteger(quantity) || quantity < 1) {
      throw new SupplierError(
        ID,
        'get_cart',
        `cart line has no usable spinId/quantity: ${JSON.stringify(cleanDeep(it)).slice(0, 200)}`,
      );
    }
    const price = isObj(it.price) ? it.price : {};
    // Live get_cart (12 Oct 2026) carries the per-unit payable price as item.discountedFinalPrice.
    let unit =
      toPaise(pick(price, 'offerPrice', 'sellingPrice', 'discountedFinalPrice')) ??
      toPaise(pick(it, 'discountedFinalPrice', 'finalPrice', 'offerPrice', 'sellingPrice', 'unitPrice'));
    if (unit === undefined) {
      const lineAmount = toPaise(pick(it, 'totalPrice', 'lineTotal', 'itemTotal'));
      if (lineAmount !== undefined && lineAmount % quantity === 0) unit = lineAmount / quantity;
    }
    const rawName = str(pick(it, 'displayName', 'itemName', 'name', 'productName')) ?? spinId;
    const brand = str(pick(it, 'brandName', 'brand'));
    const base = `${ID}:cart:${spinId}`;
    const name = sanitiseField(rawName, `${base}.name`, log, '(name withheld)');
    if (it.isInStockAndAvailable === false || it.inStock === false) {
      unavailable.push({ itemKey: itemKeys.get(spinId) ?? name, reason: 'out of stock' });
      continue;
    }
    if (unit === undefined) {
      throw new SupplierError(ID, 'get_cart', `cannot determine unit price for ${spinId}`);
    }
    const skuId = str(it.skuId);
    const itemKey = itemKeys.get(spinId);
    lines.push({
      ...(itemKey !== undefined ? { itemKey } : {}),
      variantId: spinId,
      ...(skuId !== undefined ? { skuId } : {}),
      name,
      label: sanitiseField(
        str(pick(it, 'quantityDescription', 'itemVariant', 'variantDescription')) ?? '',
        `${base}.label`,
        log,
      ),
      quantity,
      unitPrice: unit,
      lineTotal: unit * quantity,
      category: classify(rawName, brand),
    });
  }

  const bill = parseBill(pick(cart, 'bill', 'billDetails', 'billBreakdown', 'pricing', 'orderSummary') ?? {}, log);
  const itemTotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  if (lines.length === 0 && unavailable.length === 0 && (bill.total === undefined || bill.total === 0)) {
    return { lines, unavailable, fees: [], itemTotal: 0, total: 0 };
  }
  if (bill.total === undefined) throw new SupplierError(ID, 'get_cart', 'bill has no to-pay total');
  if (bill.itemTotal !== undefined && bill.itemTotal !== itemTotal) {
    throw new SupplierError(
      ID,
      'get_cart',
      `bill item total ${bill.itemTotal} paise does not match the cart lines (${itemTotal} paise); refusing to price this cart`,
    );
  }
  // Swiggy rounds To Pay to the whole rupee (live: 1383.00 + 12.98 -> 1396). Record a sub-rupee
  // difference as an explicit 'rounding' fee so the quote still reconciles exactly and the hash covers it.
  const preRound = bill.fees.reduce((s, f) => s + f.amount, 0);
  const roundingDiff = bill.total - (itemTotal + preRound);
  if (roundingDiff !== 0 && Math.abs(roundingDiff) < 100) bill.fees.push({ label: 'rounding', amount: roundingDiff });
  const feeSum = bill.fees.reduce((s, f) => s + f.amount, 0);
  if (itemTotal + feeSum !== bill.total) {
    throw new SupplierError(
      ID,
      'get_cart',
      `bill does not reconcile: items ${itemTotal} + fees ${feeSum} != to-pay ${bill.total} (paise); refusing to price this cart`,
    );
  }
  const eta = etaMinutes(pick(cart, 'sla', 'eta')) ?? num(pick(cart, 'etaMinutes'));
  return {
    lines,
    unavailable,
    fees: bill.fees,
    itemTotal,
    total: bill.total,
    ...(eta !== undefined ? { etaMinutes: Math.round(eta) } : {}),
  };
}

// ---------- order / checkout parsing ----------

const FAILED_RE = /fail|cancel|reject|declin|expired|error|refund/i;
const PENDING_RE = /pending|awaiting/i;

interface CheckoutOrder {
  orderId: string;
  status: PlacedOrder['status'];
  paasId?: string;
  transactionId?: string;
}

function orderRecords(raw: unknown): Json[] {
  if (Array.isArray(raw)) return raw.filter(isObj);
  if (!isObj(raw)) return [];
  for (const k of ['orders', 'results', 'storeOrders', 'data']) {
    const v = raw[k];
    if (Array.isArray(v)) return v.filter(isObj);
    if (isObj(v)) {
      const inner = orderRecords(v);
      if (inner.length > 0) return inner;
    }
  }
  return str(pick(raw, 'orderId', 'id')) ? [raw] : [];
}

function parseCheckout(raw: unknown): CheckoutOrder[] {
  const records = orderRecords(raw);
  const orders: CheckoutOrder[] = [];
  for (const r of records) {
    const orderId = str(pick(r, 'orderId', 'id'));
    if (!orderId) continue;
    const status = (str(pick(r, 'status', 'orderStatus')) ?? '').toUpperCase();
    const paasId = str(pick(r, 'paasId', 'paymentId'));
    const transactionId = str(pick(r, 'transactionId', 'txnId'));
    orders.push({
      orderId,
      status: FAILED_RE.test(status)
        ? 'failed'
        : PENDING_RE.test(status) || (paasId !== undefined && status === '')
          ? 'pending_payment'
          : 'placed',
      ...(paasId !== undefined ? { paasId } : {}),
      ...(transactionId !== undefined ? { transactionId } : {}),
    });
  }
  return orders;
}

function statusOf(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim().toUpperCase();
  if (isObj(raw)) return (str(pick(raw, 'status', 'paymentStatus', 'state')) ?? '').trim().toUpperCase();
  return '';
}

function epochOrIso(v: unknown, fallback: string): string {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return epochOrIso(n, fallback);
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback;
}

// ---------- adapter ----------

export class InstamartSupplier implements Supplier {
  readonly id = ID;
  private readonly call: CallTool;
  private readonly now: () => string;
  private readonly log: SanitiseLog | undefined;
  /** variantId -> itemKey from the last quote(); the server never sees item keys. */
  private itemKeys = new Map<string, string>();

  constructor(opts: InstamartAdapterOptions) {
    this.call = opts.callTool;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.log = opts.log;
  }

  private addressId(place: Place, op: string): string {
    const id = place.supplierAddressIds.instamart;
    if (!id) throw new SupplierError(ID, op, `no Instamart address saved for ${place.nickname}`);
    return id;
  }

  async checkServiceability(place: Place): Promise<Serviceability> {
    const checkedAt = this.now();
    const addressId = place.supplierAddressIds.instamart;
    if (!addressId) return { supplierId: ID, serviceable: false, checkedAt };
    let products: SupplierProduct[];
    try {
      products = mapProducts(await this.call('search_products', { query: 'milk', addressId }), this.log);
    } catch (e) {
      if (
        e instanceof SupplierError &&
        /serviceab|not deliver|no stores?|outside .*area|not available (?:at|in) (?:this|your)/i.test(e.message)
      ) {
        return { supplierId: ID, serviceable: false, checkedAt };
      }
      throw e;
    }
    const etas = products
      .flatMap((p) => p.variants.filter((v) => v.inStock).map((v) => v.etaMinutes))
      .filter((x): x is number => x !== undefined);
    const serviceable = products.length >= 1;
    return {
      supplierId: ID,
      serviceable,
      checkedAt,
      ...(serviceable && etas.length > 0 ? { lastEtaMinutes: Math.min(...etas) } : {}),
    };
  }

  async search(query: string, place: Place): Promise<SupplierProduct[]> {
    const addressId = this.addressId(place, 'search_products');
    return mapProducts(await this.call('search_products', { query: query.slice(0, 256), addressId }), this.log);
  }

  async goToItems(place: Place): Promise<SupplierProduct[]> {
    const addressId = this.addressId(place, 'your_go_to_items');
    return mapProducts(await this.call('your_go_to_items', { addressId }), this.log);
  }

  async quote(lines: CartLine[], place: Place): Promise<Quote> {
    const addressId = this.addressId(place, 'update_cart');
    const merged = new Map<string, CartLine>();
    for (const l of lines) {
      if (!Number.isInteger(l.quantity) || l.quantity < 1) {
        throw new SupplierError(ID, 'update_cart', `quantity must be an integer >= 1 for ${l.variantId}`);
      }
      const prev = merged.get(l.variantId);
      if (prev) merged.set(l.variantId, { ...prev, quantity: prev.quantity + l.quantity });
      else merged.set(l.variantId, { ...l });
    }
    this.itemKeys = new Map();
    for (const l of merged.values()) if (l.reason.itemKey) this.itemKeys.set(l.variantId, l.reason.itemKey);

    if (merged.size === 0) {
      await this.clearCart();
      return this.build([], [], [], 0, place, addressId);
    }

    // update_cart REPLACES the whole cart: send the full desired cart once.
    await this.call('update_cart', {
      items: [...merged.values()].map((l) => ({
        spinId: l.variantId,
        ...(l.skuId ? { skuId: l.skuId } : {}),
        quantity: l.quantity,
      })),
      selectedAddressId: addressId,
    });
    const parsed = parseCart(await this.call('get_cart', {}), this.itemKeys, this.log);
    assertCartAddress(parsed, addressId, 'quote');

    const unavailable = [...parsed.unavailable];
    const inCart = new Set(parsed.lines.map((l) => l.variantId));
    for (const l of merged.values()) {
      if (!inCart.has(l.variantId) && !parsed.unavailable.some((u) => u.itemKey === (l.reason.itemKey ?? ''))) {
        unavailable.push({ itemKey: l.reason.itemKey ?? l.variantId, reason: 'not in cart after update' });
      }
    }
    return this.build(parsed.lines, parsed.fees, unavailable, parsed.total, place, addressId, parsed.etaMinutes);
  }

  async readCart(place: Place): Promise<Quote> {
    const addressId = this.addressId(place, 'get_cart');
    const parsed = parseCart(await this.call('get_cart', {}), this.itemKeys, this.log);
    assertCartAddress(parsed, addressId, 'readCart');
    return this.build(parsed.lines, parsed.fees, parsed.unavailable, parsed.total, place, addressId, parsed.etaMinutes);
  }

  private build(
    lines: QuoteLine[],
    fees: { label: string; amount: Paise }[],
    unavailable: Quote['unavailable'],
    total: Paise,
    place: Pick<Place, 'id'>,
    supplierAddressId: string,
    eta?: number,
  ): Quote {
    const itemTotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const body = { supplierId: ID, placeId: place.id, supplierAddressId, lines, itemTotal, fees, total };
    return {
      id: newId('q'),
      hash: quoteHash(body),
      ...body,
      ...(eta !== undefined ? { etaMinutes: eta } : {}),
      createdAt: this.now(),
      unavailable,
    };
  }

  async clearCart(): Promise<void> {
    await this.call('clear_cart', {});
  }

  /**
   * The account's saved delivery addresses (get_addresses, all pages), sanitised: id byte-for-byte, tag / category /
   * address line through core/sanitise.ts. Phone numbers (even masked) are dropped and never leave this module.
   */
  async getAddresses(): Promise<SupplierAddress[]> {
    const out: SupplierAddress[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_ADDRESS_PAGES; page++) {
      const raw = await this.call('get_addresses', { page, pageSize: 10 });
      const root = isObj(raw) ? raw : {};
      for (const a of arr(root.addresses)) {
        if (!isObj(a)) continue;
        const id = str(a.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const field = (k: string) => {
          const v = str(a[k]);
          return v === undefined ? '' : sanitiseField(v, `${ID}:address:${id}.${k}`, this.log);
        };
        out.push({
          id,
          tag: field('addressTag'),
          category: field('addressCategory'),
          addressLine: field('addressLine'),
        });
      }
      const pg = isObj(root.pagination) ? root.pagination : {};
      if (pg.hasMore !== true) break;
    }
    return out;
  }

  /** The parsed get_payment_options result; the agent needs the UPI method ids (exact bytes) for place(). */
  async paymentOptions(): Promise<PaymentOptions> {
    const raw = await this.call('get_payment_options', {});
    const root = isObj(raw) ? raw : {};
    const methodsOf = (v: unknown): PaymentMethodOption[] => {
      const list = isObj(v) ? arr(v.methods) : arr(v);
      const out: PaymentMethodOption[] = [];
      for (const m of list) {
        const id = isObj(m) ? str(m.id) : typeof m === 'string' ? m : undefined;
        if (!id) continue;
        const name = isObj(m) ? str(pick(m, 'name', 'displayName', 'label', 'title')) : undefined;
        const type = isObj(m) ? str(pick(m, 'type', 'category', 'kind')) : undefined;
        out.push({
          id,
          ...(name !== undefined ? { name: sanitiseField(name, `${ID}:payment:${id}.name`, this.log) } : {}),
          ...(type !== undefined ? { type: sanitiseField(type, `${ID}:payment:${id}.type`, this.log) } : {}),
        });
      }
      return out;
    };
    const platforms = isObj(root.platforms) ? root.platforms : {};
    const cod = root.cod;
    return {
      mobile: methodsOf(platforms.mobile),
      desktop: methodsOf(platforms.desktop),
      all: methodsOf(root.allMethods),
      codAvailable:
        cod !== undefined &&
        cod !== null &&
        cod !== false &&
        !(isObj(cod) && (cod.enabled === false || cod.available === false)),
      raw: cleanDeep(raw),
    };
  }

  async place(quote: Quote, payment: PaymentMethod): Promise<PlacedOrder> {
    // Defence in depth on top of the gate's re-read: the server cart must still be the quoted one.
    const live = parseCart(await this.call('get_cart', {}), this.itemKeys, this.log);
    assertCartAddress(live, quote.supplierAddressId, 'place');
    const liveBody = {
      supplierId: ID,
      placeId: quote.placeId,
      supplierAddressId: quote.supplierAddressId,
      lines: live.lines,
      fees: live.fees,
      total: live.total,
    };
    const liveHash = quoteHash(liveBody);
    if (liveHash !== quote.hash) throw new QuoteMismatch(quote.hash, liveHash, 'cart changed before checkout');

    const args: Record<string, unknown> = { addressId: quote.supplierAddressId };
    if (payment.kind === 'cod') args.paymentMethod = 'Cash';
    else if (payment.kind === 'wallet') args.paymentMethod = 'SwiggyPay';
    else {
      if (!payment.intentApp)
        throw new SupplierError(ID, 'checkout', 'UPI needs intentApp (a method id from get_payment_options)');
      args.paymentMethod = 'UPI';
      args.intentApp = payment.intentApp; // byte-for-byte
    }
    // Single attempt. No retry here or in the MCP client; no confirmDuplicate unless a human re-drives it.
    const orders = parseCheckout(await this.call('checkout', args));
    if (orders.length === 0) {
      throw new SupplierError(
        ID,
        'checkout',
        'checkout returned no order id; outcome unknown, check get_orders before any retry',
      );
    }

    const settled: PlacedOrder['status'][] = [];
    for (const o of orders) {
      let status = o.status;
      if (payment.kind === 'upi' && status === 'pending_payment' && o.paasId) {
        const paid = statusOf(await this.call('check_payment_status', { paasId: o.paasId, orderId: o.orderId }));
        if (paid === 'SUCCESS' || paid === 'PAID') {
          try {
            await this.call('confirm_order', {
              orderId: o.orderId,
              paasId: o.paasId,
              ...(o.transactionId ? { transactionId: o.transactionId } : {}),
            });
          } catch (e) {
            throw new SupplierError(
              ID,
              'confirm_order',
              `payment ${o.paasId} succeeded but confirm_order failed for order ${o.orderId}: ${e instanceof Error ? e.message : String(e)}`,
              { cause: e },
            );
          }
          status = 'placed';
        } else if (FAILED_RE.test(paid)) status = 'failed';
        // PENDING or unknown: stay pending_payment; the caller polls later, never re-sends checkout.
      }
      settled.push(status);
    }
    const status: PlacedOrder['status'] = settled.includes('pending_payment')
      ? 'pending_payment'
      : settled.includes('placed')
        ? 'placed'
        : 'failed';
    const paasIds = orders.map((o) => o.paasId).filter((x): x is string => x !== undefined);
    return {
      supplierId: ID,
      supplierOrderId: orders.map((o) => o.orderId).join(','),
      quoteId: quote.id,
      status,
      ...(paasIds.length > 0 ? { paymentRef: paasIds.join(',') } : {}),
      placedAt: this.now(),
    };
  }

  async track(order: PlacedOrder, place: Place): Promise<{ status: string; etaMinutes?: number; raw: unknown }> {
    if (place.lat === undefined || place.lng === undefined) {
      throw new SupplierError(ID, 'track_order', `track_order needs coordinates and ${place.nickname} has none`);
    }
    const orderId = order.supplierOrderId.split(',')[0]!;
    const raw = await this.call('track_order', { orderId, lat: place.lat, lng: place.lng });
    const r = isObj(raw) ? raw : {};
    const inner = isObj(r.order) ? r.order : r;
    const status = sanitiseField(
      str(pick(inner, 'status', 'orderStatus', 'currentStatus')) ?? 'UNKNOWN',
      `${ID}:track.status`,
      this.log,
    );
    const eta = etaMinutes(pick(inner, 'eta', 'sla')) ?? num(pick(inner, 'etaMinutes', 'etaInMinutes'));
    return { status, ...(eta !== undefined ? { etaMinutes: Math.round(eta) } : {}), raw: cleanDeep(raw) };
  }

  async orders(opts: { count?: number; activeOnly?: boolean } = {}): Promise<LedgerOrderInput[]> {
    const raw = await this.call('get_orders', {
      count: Math.min(opts.count ?? 20, 20),
      ...(opts.activeOnly ? { activeOnly: true } : {}),
      orderType: 'DASH',
    });
    const out: LedgerOrderInput[] = [];
    for (const o of orderRecords(raw)) {
      const orderId = str(pick(o, 'orderId', 'id'));
      if (!orderId) continue;
      const lines: LedgerOrderInput['lines'] = [];
      for (const it of arr(pick(o, 'items', 'lineItems', 'products'))) {
        if (!isObj(it)) continue;
        const quantity = num(it.quantity) ?? 1;
        const price = isObj(it.price) ? it.price : {};
        const total0 = toPaise(pick(it, 'totalPrice', 'lineTotal'));
        const unit0 =
          toPaise(pick(price, 'offerPrice', 'sellingPrice')) ??
          toPaise(pick(it, 'offerPrice', 'sellingPrice', 'unitPrice'));
        const unitPrice = unit0 ?? (total0 !== undefined && quantity > 0 ? Math.round(total0 / quantity) : 0);
        const rawName = str(pick(it, 'displayName', 'name', 'productName')) ?? '(unknown item)';
        const variantId = str(it.spinId);
        lines.push({
          name: sanitiseField(rawName, `${ID}:order:${orderId}.item`, this.log, '(name withheld)'),
          ...(variantId !== undefined ? { variantId } : {}),
          quantity,
          unitPrice,
          lineTotal: total0 ?? unitPrice * quantity,
          category: classify(rawName, str(pick(it, 'brandName', 'brand'))),
        });
      }
      const bill = parseBill(pick(o, 'bill', 'billDetails', 'billBreakdown') ?? {}, this.log);
      const itemSum = lines.reduce((s, l) => s + l.lineTotal, 0);
      const fees = bill.fees;
      const total =
        toPaise(pick(o, 'totalAmount', 'toPay', 'amountPaid', 'total')) ??
        bill.total ??
        itemSum + fees.reduce((s, f) => s + f.amount, 0);
      const addr = isObj(o.address) ? o.address : isObj(o.deliveryAddress) ? o.deliveryAddress : {};
      const supplierAddressId = str(pick(o, 'addressId', 'deliveryAddressId')) ?? str(pick(addr, 'addressId', 'id'));
      out.push({
        supplierId: ID,
        supplierOrderId: orderId,
        placedAt: epochOrIso(pick(o, 'createdAt', 'orderTime', 'placedAt', 'orderedAt', 'time'), this.now()),
        ...(supplierAddressId !== undefined ? { supplierAddressId } : {}),
        lines,
        fees,
        total,
        status: sanitiseField(
          str(pick(o, 'status', 'orderStatus')) ?? 'UNKNOWN',
          `${ID}:order:${orderId}.status`,
          this.log,
        ),
        raw: cleanDeep(o),
      });
    }
    return out;
  }
}
