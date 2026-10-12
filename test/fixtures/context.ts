/** Deterministic builders for policy tests. No I/O. */
import { quoteHash } from '../../src/core/hash.js';
import type {
  Approval,
  Household,
  ItemCategory,
  Member,
  Place,
  PolicyContext,
  Quote,
  QuoteLine,
} from '../../src/core/types.js';
import { foundingHousehold } from '../../src/db/seed-data.js';

export const NOW = '2026-10-12T14:00:00.000Z'; // 19:30 IST

export function household(): Household {
  let n = 0;
  return foundingHousehold((prefix) => `${prefix}_${String(++n).padStart(2, '0')}`);
}

export function placeNamed(h: Household, nickname: string): Place {
  const p = h.places.find((x) => x.nickname === nickname);
  if (!p) throw new Error(`no place ${nickname}`);
  return p;
}

export function owner(h: Household): Member {
  return h.members.find((m) => m.role === 'owner')!;
}

export function adder(h: Household): Member {
  return h.members.find((m) => m.role === 'adder')!;
}

export function line(
  variantId: string,
  category: ItemCategory,
  unitPrice: number,
  quantity = 1,
  name = variantId,
): QuoteLine {
  return { variantId, name, label: '1 unit', quantity, unitPrice, lineTotal: unitPrice * quantity, category };
}

/** A hashed quote whose total = sum(lines) + fees. */
export function makeQuote(
  place: Place,
  lines: QuoteLine[],
  fees: { label: string; amount: number }[] = [],
  extra: Partial<Quote> = {},
): Quote {
  const itemTotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const total = itemTotal + fees.reduce((s, f) => s + f.amount, 0);
  const q: Omit<Quote, 'hash'> = {
    id: 'q_test',
    supplierId: 'instamart',
    placeId: place.id,
    supplierAddressId: place.supplierAddressIds.instamart!,
    lines,
    itemTotal,
    fees,
    total,
    createdAt: NOW,
    unavailable: [],
    ...extra,
  };
  return { ...q, hash: quoteHash(q) } as Quote;
}

/** ₹1,123 all-grocery cart: 1,100 of items + ₹8 handling + ₹15 delivery. */
export function groceryCart1123(place: Place): Quote {
  return makeQuote(
    place,
    [line('v-rice', 'grocery', 18000, 3), line('v-milk', 'dairy', 12000, 4), line('v-atta', 'grocery', 8000, 1)],
    [
      { label: 'handling', amount: 800 },
      { label: 'delivery', amount: 1500 },
    ],
  );
}

/** ₹412 cart: 380 of items + ₹8 handling + ₹24 delivery. */
export function groceryCart412(place: Place): Quote {
  return makeQuote(
    place,
    [line('v-milk', 'dairy', 12000, 1), line('v-rice', 'grocery', 18000, 1), line('v-onion-1kg', 'produce', 4000, 2)],
    [
      { label: 'handling', amount: 800 },
      { label: 'delivery', amount: 2400 },
    ],
  );
}

export function approval(h: Household, quoteHashValue: string, extra: Partial<Approval> = {}): Approval {
  return {
    id: 'ap_1',
    quoteHash: quoteHashValue,
    memberId: owner(h).id,
    createdAt: '2026-10-12T13:55:00.000Z',
    expiresAt: '2026-10-12T14:25:00.000Z',
    ...extra,
  };
}

export function ctx(overrides: Partial<PolicyContext> & { quote: Quote; place: Place; household: Household }) {
  const c: PolicyContext = {
    liveCart: overrides.quote,
    approvals: [],
    requestingMember: owner(overrides.household),
    spendToday: 0,
    spendThisMonth: 0,
    quantityHistory: {},
    now: NOW,
    ...overrides,
  };
  return c;
}
