/**
 * Sample data for preview mode. Invented household, invented names: nothing here is real, and nothing here is fetched.
 * Money is integer paise, like the API. Timestamps are relative to "now" so the lists always read as recent.
 */
import type { CartsResponse, HeldCart, HouseholdResponse, LedgerSummary, Me, OrderSummary } from '../types';

const MIN = 60_000;
const ago = (minutes: number, now: number): string => new Date(now - minutes * MIN).toISOString();

export function sampleMe(): Me {
  return {
    member: { id: 'sm_aarav', name: 'Aarav', role: 'owner' },
    household: { id: 'sh_1', name: 'Sample household' },
    pinSet: true,
    pinLocked: false,
  };
}

export function sampleCarts(now: number = Date.now()): CartsResponse {
  const fromPartner: HeldCart = {
    quoteHash: 'sample-held-1',
    member: { id: 'sm_meera', name: 'Meera' },
    place: { id: 'sp_silchar', nickname: 'Silchar flat' },
    supplier: 'instamart',
    lines: [
      { name: 'Basmati rice', label: '5 kg', qty: 1, lineTotal: 71900 },
      { name: 'Sunflower oil', label: '1 L', qty: 2, lineTotal: 39800 },
      { name: 'Toor dal', label: '1 kg', qty: 1, lineTotal: 18900 },
      { name: 'Salted butter', label: '500 g', qty: 1, lineTotal: 28500 },
      { name: 'Iodised salt', label: '1 kg', qty: 2, lineTotal: 5600 },
      { name: 'Bananas', label: '1 kg', qty: 1, lineTotal: 6500 },
    ],
    fees: [
      { label: 'Handling', amount: 500 },
      { label: 'Delivery', amount: 3000 },
    ],
    total: 174700,
    etaMinutes: 18,
    createdAt: ago(12, now),
    reasons: ['per_order_ceiling', 'role'],
    needsPin: true,
    approvable: true,
  };
  const forFamily: HeldCart = {
    quoteHash: 'sample-held-2',
    member: { id: 'sm_baba', name: 'Baba' },
    place: { id: 'sp_guwahati', nickname: 'Guwahati, Ma and Baba' },
    supplier: 'instamart',
    lines: [
      { name: 'Marie Gold biscuits', label: '250 g', qty: 2, lineTotal: 7000 },
      { name: 'Toned milk', label: '1 L', qty: 2, lineTotal: 15200 },
      { name: 'Eggs', label: '12 pack', qty: 1, lineTotal: 9600 },
    ],
    fees: [
      { label: 'Handling', amount: 500 },
      { label: 'Delivery', amount: 2500 },
    ],
    total: 34800,
    etaMinutes: 24,
    createdAt: ago(95, now),
    reasons: ['role'],
    needsPin: false,
    approvable: true,
  };
  const order = (
    id: string,
    minutesAgo: number,
    place: string,
    member: string,
    total: number,
    status = 'delivered',
  ): OrderSummary => ({
    supplierOrderId: id,
    placedAt: ago(minutesAgo, now),
    place: { nickname: place },
    total,
    status,
    member: { name: member },
  });
  return {
    held: [fromPartner, forFamily],
    recent: [
      order('so_1', 60 * 20, 'Silchar flat', 'Aarav', 48600),
      order('so_2', 60 * 31, 'Guwahati, Ma and Baba', 'Meera', 92400),
      order('so_3', 60 * 52, 'Silchar office', 'Aarav', 21900),
      order('so_4', 60 * 77, 'Silchar flat', 'Meera', 63500),
      order('so_5', 60 * 100, 'Guwahati, Ma and Baba', 'Baba', 31200),
    ],
  };
}

export function sampleHousehold(): HouseholdResponse {
  return {
    members: [
      {
        id: 'sm_aarav',
        name: 'Aarav',
        role: 'owner',
        phones: ['+919000000001'],
        defaultPlaceId: 'sp_silchar',
        hasPasskey: true,
      },
      {
        id: 'sm_meera',
        name: 'Meera',
        role: 'adder',
        phones: ['+919000000002'],
        defaultPlaceId: 'sp_silchar',
        hasPasskey: true,
      },
      {
        id: 'sm_ma',
        name: 'Ma',
        role: 'dependant',
        phones: ['+919000000003'],
        defaultPlaceId: 'sp_guwahati',
        hasPasskey: false,
      },
      {
        id: 'sm_baba',
        name: 'Baba',
        role: 'dependant',
        phones: ['+919000000004'],
        defaultPlaceId: 'sp_guwahati',
        hasPasskey: false,
      },
    ],
    places: [
      {
        id: 'sp_silchar',
        key: 'silchar-flat',
        nickname: 'Silchar flat',
        aliases: ['home', 'ghar'],
        city: 'Silchar',
        trusted: true,
        isDefault: true,
      },
      {
        id: 'sp_office',
        key: 'silchar-office',
        nickname: 'Silchar office',
        aliases: ['office'],
        city: 'Silchar',
        trusted: true,
        isDefault: false,
      },
      {
        id: 'sp_guwahati',
        key: 'guwahati-ma-baba',
        nickname: 'Guwahati, Ma and Baba',
        aliases: ['Guwahati', 'Ma er bari'],
        city: 'Guwahati',
        trusted: true,
        isDefault: false,
      },
      {
        id: 'sp_shillong',
        key: 'shillong-guest-house',
        nickname: 'Shillong guest house',
        aliases: [],
        city: 'Shillong',
        trusted: false,
        isDefault: false,
      },
      {
        id: 'sp_kolkata',
        key: 'kolkata-flat',
        nickname: 'Kolkata flat',
        aliases: ['Kolkata'],
        city: 'Kolkata',
        trusted: true,
        isDefault: false,
      },
    ],
  };
}

export function sampleSupplierAddresses(): unknown {
  return {
    addresses: [
      { id: 'ia_1', tag: 'Work', category: 'Work', addressLine: 'Tarapur, Silchar' },
      { id: 'ia_2', tag: 'Friend', category: 'Others', addressLine: 'Zoo Road, Guwahati' },
    ],
    available: true,
  };
}

/** One plausible month; the month asked for is echoed back so the picker works. Sums are consistent. */
export function sampleLedger(month: string): LedgerSummary {
  return {
    month,
    orderCount: 14,
    total: 1280700,
    itemTotal: 1184200,
    byCategory: [
      { key: 'produce', total: 312000, count: 9 },
      { key: 'staples', total: 301200, count: 8 },
      { key: 'dairy', total: 228500, count: 11 },
      { key: 'household', total: 148000, count: 4 },
      { key: 'snacks', total: 112500, count: 5 },
      { key: 'medicines', total: 82000, count: 2 },
    ],
    byPlace: [
      { key: 'Silchar flat', total: 586000, count: 6 },
      { key: 'Guwahati, Ma and Baba', total: 412700, count: 4 },
      { key: 'Silchar office', total: 194000, count: 3 },
      { key: 'Shillong guest house', total: 88000, count: 1 },
    ],
    byMember: [
      { key: 'Aarav', total: 702000, count: 7 },
      { key: 'Meera', total: 421700, count: 5 },
      { key: 'Baba', total: 157000, count: 2 },
    ],
    fees: {
      total: 96500,
      byLabel: [
        { label: 'Delivery', total: 41000 },
        { label: 'Handling', total: 29500 },
        { label: 'Small cart', total: 26000 },
      ],
    },
    smallOrders: { thresholdPaise: 20000, count: 3, fees: 26000, batchingWouldHaveSaved: 19500 },
  };
}
