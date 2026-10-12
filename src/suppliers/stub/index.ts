/**
 * In-memory Supplier for tests. Behaves like Instamart where it matters:
 * a single server-side cart that update/quote REPLACES, priced bills with fees, hashed quotes,
 * and a live cart that can drift outside the session (price changes, items added elsewhere).
 */
import { QuoteMismatch, SupplierError } from '../../core/errors.js';
import { quoteHash } from '../../core/hash.js';
import { newId } from '../../core/ids.js';
import type {
  CartLine,
  LedgerOrderInput,
  PaymentMethod,
  Place,
  PlacedOrder,
  Quote,
  QuoteLine,
  Serviceability,
  Supplier,
  SupplierId,
  SupplierProduct,
} from '../../core/types.js';

export const STUB_CATALOGUE: SupplierProduct[] = [
  {
    supplierId: 'instamart',
    productId: 'p-milk',
    name: 'Amul Lactose Free Milk',
    brand: 'Amul',
    category: 'dairy',
    variants: [{ variantId: 'v-milk', label: '250 ml x 4', mrp: 12500, price: 12000, inStock: true, maxQuantity: 6 }],
  },
  {
    supplierId: 'instamart',
    productId: 'p-rice',
    name: 'Daawat Biryani Basmati Rice',
    brand: 'Daawat',
    category: 'grocery',
    variants: [{ variantId: 'v-rice', label: '1 kg', mrp: 20000, price: 18000, inStock: true }],
  },
  {
    supplierId: 'instamart',
    productId: 'p-chicken',
    name: 'Meatzza Chicken Curry Cut (Bone-in)',
    brand: 'Meatzza',
    category: 'meat',
    variants: [{ variantId: 'v-chicken', label: '500 g', mrp: 28000, price: 26000, inStock: true }],
  },
  {
    supplierId: 'instamart',
    productId: 'p-cooker',
    name: 'Prestige Pressure Cooker',
    brand: 'Prestige',
    category: 'appliances',
    variants: [{ variantId: 'v-cooker', label: '5 L', mrp: 240000, price: 200000, inStock: true }],
  },
  {
    supplierId: 'instamart',
    productId: 'p-onion',
    name: 'Onion',
    category: 'produce',
    variants: [{ variantId: 'v-onion-1kg', label: '1 kg', mrp: 5000, price: 4000, inStock: true }],
  },
];

export const STUB_HANDLING_FEE = 800; // ₹8
export const STUB_SMALL_CART_DELIVERY_FEE = 2400; // ₹24 below ₹999 of items
export const STUB_DELIVERY_FEE = 1500; // ₹15 at or above ₹999 of items
const FREE_DELIVERY_THRESHOLD = 99900;

export function stubFees(itemTotal: number): { label: string; amount: number }[] {
  if (itemTotal === 0) return [];
  return [
    { label: 'handling', amount: STUB_HANDLING_FEE },
    {
      label: 'delivery',
      amount: itemTotal >= FREE_DELIVERY_THRESHOLD ? STUB_DELIVERY_FEE : STUB_SMALL_CART_DELIVERY_FEE,
    },
  ];
}

interface ServerCartLine {
  variantId: string;
  quantity: number;
}

/** Mutates the server-side cart as seen by readCart(); simulates edits made outside the session. */
export type CartDrift = (lines: ServerCartLine[]) => ServerCartLine[];

export interface StubSupplierOptions {
  id?: SupplierId;
  catalogue?: SupplierProduct[];
  /** Places (by id) the stub refuses to serve. */
  unserviceablePlaceIds?: string[];
  etaMinutes?: number;
  now?: () => string;
}

export class StubSupplier implements Supplier {
  readonly id: SupplierId;
  private readonly catalogue: SupplierProduct[];
  private readonly prices = new Map<string, number>();
  private readonly stock = new Map<string, boolean>();
  private readonly unserviceable: Set<string>;
  private readonly etaMinutes: number;
  private readonly now: () => string;
  private cart: ServerCartLine[] = [];
  private cartAddressId: string | undefined;
  private drift: CartDrift | undefined;

  /** Every successful place() call, for assertions. */
  readonly placed: { quote: Quote; payment: PaymentMethod; order: PlacedOrder }[] = [];
  /** Every place() call, including refused ones. */
  placeCalls = 0;

  constructor(opts: StubSupplierOptions = {}) {
    this.id = opts.id ?? 'instamart';
    this.catalogue = structuredClone(opts.catalogue ?? STUB_CATALOGUE).map((p) => ({ ...p, supplierId: this.id }));
    for (const p of this.catalogue) {
      for (const v of p.variants) {
        this.prices.set(v.variantId, v.price);
        this.stock.set(v.variantId, v.inStock);
      }
    }
    this.unserviceable = new Set(opts.unserviceablePlaceIds ?? []);
    this.etaMinutes = opts.etaMinutes ?? 15;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  // ---- test controls ----

  /** Change a live price (affects readCart and later quotes, not quotes already issued). */
  setPrice(variantId: string, price: number): void {
    this.find(variantId);
    this.prices.set(variantId, price);
  }

  setInStock(variantId: string, inStock: boolean): void {
    this.find(variantId);
    this.stock.set(variantId, inStock);
  }

  /** Persistent drift applied whenever the live cart is read (null clears it). */
  setDrift(drift: CartDrift | null): void {
    this.drift = drift ?? undefined;
  }

  /** Someone edits the cart in the app: add or bump a line outside this session. */
  addOutsideSession(variantId: string, quantity = 1): void {
    this.find(variantId);
    const existing = this.cart.find((l) => l.variantId === variantId);
    if (existing) existing.quantity += quantity;
    else this.cart.push({ variantId, quantity });
  }

  // ---- Supplier ----

  async checkServiceability(place: Place): Promise<Serviceability> {
    const serviceable = !this.unserviceable.has(place.id) && place.supplierAddressIds[this.id] !== undefined;
    return {
      supplierId: this.id,
      serviceable,
      checkedAt: this.now(),
      ...(serviceable ? { lastEtaMinutes: this.etaMinutes } : {}),
    };
  }

  async search(query: string, place: Place): Promise<SupplierProduct[]> {
    this.addressFor(place);
    const q = query.trim().toLowerCase();
    return structuredClone(
      this.catalogue
        .filter((p) => p.name.toLowerCase().includes(q) || p.category === q)
        .map((p) => ({
          ...p,
          variants: p.variants.map((v) => ({
            ...v,
            price: this.prices.get(v.variantId)!,
            inStock: this.stock.get(v.variantId)!,
            etaMinutes: this.etaMinutes,
          })),
        })),
    );
  }

  async goToItems(_place: Place): Promise<SupplierProduct[]> {
    return [];
  }

  async quote(lines: CartLine[], place: Place): Promise<Quote> {
    const addressId = this.addressFor(place);
    const unavailable: Quote['unavailable'] = [];
    const next: ServerCartLine[] = [];
    for (const l of lines) {
      if (!Number.isInteger(l.quantity) || l.quantity < 1) {
        throw new SupplierError(this.id, 'quote', `quantity must be an integer ≥ 1 for ${l.variantId}`);
      }
      const { product } = this.find(l.variantId);
      if (!this.stock.get(l.variantId)) {
        unavailable.push({ itemKey: l.reason.itemKey ?? product.name, reason: 'out of stock' });
        continue;
      }
      const existing = next.find((x) => x.variantId === l.variantId);
      if (existing) existing.quantity += l.quantity;
      else next.push({ variantId: l.variantId, quantity: l.quantity });
    }
    // update_cart semantics: replace the whole cart.
    this.cart = next;
    this.cartAddressId = addressId;
    return this.price(this.cart, place, addressId, unavailable);
  }

  async readCart(place: Place): Promise<Quote> {
    const addressId = this.cartAddressId ?? this.addressFor(place);
    return this.price(this.liveLines(), place, addressId, []);
  }

  async clearCart(): Promise<void> {
    this.cart = [];
    this.cartAddressId = undefined;
  }

  async place(quote: Quote, payment: PaymentMethod): Promise<PlacedOrder> {
    this.placeCalls += 1;
    // Supplier-side defence in depth: the cart being checked out must still be the quoted one.
    const live = this.price(this.liveLines(), { id: quote.placeId } as Place, this.cartAddressId ?? '', []);
    if (live.hash !== quote.hash) throw new QuoteMismatch(quote.hash, live.hash, 'cart changed before checkout');
    const order: PlacedOrder = {
      supplierId: this.id,
      supplierOrderId: newId('so'),
      quoteId: quote.id,
      status: payment.kind === 'upi' ? 'pending_payment' : 'placed',
      ...(payment.kind === 'upi' ? { paymentRef: newId('paas') } : {}),
      placedAt: this.now(),
    };
    this.placed.push({ quote, payment, order });
    this.cart = [];
    this.cartAddressId = undefined;
    return order;
  }

  async track(order: PlacedOrder, _place: Place): Promise<{ status: string; etaMinutes?: number; raw: unknown }> {
    const known = this.placed.find((p) => p.order.supplierOrderId === order.supplierOrderId);
    if (!known) throw new SupplierError(this.id, 'track', `unknown order ${order.supplierOrderId}`);
    return { status: 'ON_THE_WAY', etaMinutes: this.etaMinutes, raw: { orderId: order.supplierOrderId } };
  }

  async orders(opts: { count?: number; activeOnly?: boolean } = {}): Promise<LedgerOrderInput[]> {
    return this.placed
      .slice(-(opts.count ?? 20))
      .reverse()
      .map(({ quote, order }) => ({
        supplierId: this.id,
        supplierOrderId: order.supplierOrderId,
        placedAt: order.placedAt,
        placeId: quote.placeId,
        supplierAddressId: quote.supplierAddressId,
        lines: quote.lines.map((l) => ({
          name: l.name,
          variantId: l.variantId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
          category: l.category,
        })),
        fees: quote.fees,
        total: quote.total,
        status: order.status,
        quoteHash: quote.hash,
      }));
  }

  // ---- internals ----

  private liveLines(): ServerCartLine[] {
    const lines = this.cart.map((l) => ({ ...l }));
    return this.drift ? this.drift(lines) : lines;
  }

  private find(variantId: string) {
    for (const product of this.catalogue) {
      const variant = product.variants.find((v) => v.variantId === variantId);
      if (variant) return { product, variant };
    }
    throw new SupplierError(this.id, 'cart', `unknown variant ${variantId}`);
  }

  private addressFor(place: Place): string {
    const id = place.supplierAddressIds[this.id];
    if (!id) throw new SupplierError(this.id, 'address', `no ${this.id} address saved for ${place.nickname}`);
    if (this.unserviceable.has(place.id)) {
      throw new SupplierError(this.id, 'address', `${place.nickname} is not serviceable`);
    }
    return id;
  }

  private price(
    lines: ServerCartLine[],
    place: Pick<Place, 'id'>,
    supplierAddressId: string,
    unavailable: Quote['unavailable'],
  ): Quote {
    const quoteLines: QuoteLine[] = lines.map((l) => {
      const { product, variant } = this.find(l.variantId);
      const unitPrice = this.prices.get(l.variantId)!;
      return {
        variantId: l.variantId,
        ...(variant.skuId !== undefined ? { skuId: variant.skuId } : {}),
        name: product.name,
        label: variant.label,
        quantity: l.quantity,
        unitPrice,
        lineTotal: unitPrice * l.quantity,
        category: product.category,
      };
    });
    const itemTotal = quoteLines.reduce((s, l) => s + l.lineTotal, 0);
    const fees = stubFees(itemTotal);
    const total = itemTotal + fees.reduce((s, f) => s + f.amount, 0);
    const body = {
      supplierId: this.id,
      placeId: place.id,
      supplierAddressId,
      lines: quoteLines,
      itemTotal,
      fees,
      total,
    };
    return {
      id: newId('q'),
      hash: quoteHash(body),
      ...body,
      etaMinutes: this.etaMinutes,
      createdAt: this.now(),
      unavailable,
    };
  }
}
