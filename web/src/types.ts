/** Shapes from docs/WEB_API.md. Money fields are integer paise. */

export interface Me {
  member: { id: string; name: string; role: Role };
  household: { id: string; name: string };
  pinSet: boolean;
  pinLocked: boolean;
}

export type Role = 'owner' | 'adder' | 'dependant' | (string & {});

export interface CartLine {
  name: string;
  label?: string;
  qty: number;
  lineTotal: number;
}
export interface CartFee {
  label: string;
  amount: number;
}

export interface HeldCart {
  quoteHash: string;
  member: { id: string; name: string };
  place: { id: string; nickname: string };
  supplier: string;
  lines: CartLine[];
  fees: CartFee[];
  total: number;
  etaMinutes?: number;
  createdAt: string;
  reasons: string[];
  needsPin: boolean;
  approvable: boolean;
}

export interface OrderSummary {
  supplierOrderId: string;
  placedAt: string;
  place: { id?: string; nickname?: string } | string;
  total: number;
  status: string;
  member: { id?: string; name?: string } | string;
}

export interface CartsResponse {
  held: HeldCart[];
  recent: OrderSummary[];
}

export interface ApproveResponse {
  decision?: string | { verdict?: string; reasons?: unknown[] };
  order?: { supplierOrderId?: string; status?: string; etaMinutes?: number } & Record<string, unknown>;
  needsPin?: boolean;
  pinLocked?: boolean;
}

export interface HouseholdMember {
  id: string;
  name: string;
  role: Role;
  phones: string[];
  defaultPlaceId?: string | null;
  hasPasskey: boolean;
}

export interface HouseholdPlace {
  id: string;
  key: string;
  nickname: string;
  aliases: string[];
  city: string;
  trusted: boolean;
  isDefault: boolean;
  supplierAddressIds?: string[];
  serviceability?: unknown;
}

export interface HouseholdResponse {
  members: HouseholdMember[];
  places: HouseholdPlace[];
}

export interface SpendBucket {
  key: string;
  total: number;
  count: number;
}

/** Mirrors src/ledger/queries.ts MonthlySummary (the "existing ledger summary"). */
export interface LedgerSummary {
  month: string;
  orderCount: number;
  total: number;
  itemTotal: number;
  byCategory: SpendBucket[];
  byPlace: SpendBucket[];
  byMember: SpendBucket[];
  fees: { total: number; byLabel: { label: string; total: number }[] };
  smallOrders: { thresholdPaise: number; count: number; fees: number; batchingWouldHaveSaved: number };
}
