/**
 * Which suppliers can deliver to a place right now. Cached records under 24 h old are trusted; the rest are
 * probed with Supplier.checkServiceability. The caller persists `records`.
 */
import type { ISODateTime, Place, Serviceability, Supplier } from '../core/types.js';

export const SERVICEABILITY_TTL_MS = 24 * 60 * 60 * 1000;

export interface ServiceableResult {
  /** Suppliers that deliver to the place (fresh cache says yes, or the probe said yes). */
  suppliers: Supplier[];
  /** The place's full serviceability list after merging probes; persist this. */
  records: Serviceability[];
  /** Only the records that were just probed (empty when everything came from cache). */
  probed: Serviceability[];
}

function isFresh(s: Serviceability, now: number): boolean {
  const at = Date.parse(s.checkedAt);
  return !Number.isNaN(at) && at <= now && now - at < SERVICEABILITY_TTL_MS;
}

export async function getServiceable(
  place: Place,
  suppliers: Supplier[],
  now: ISODateTime,
): Promise<ServiceableResult> {
  const nowMs = Date.parse(now);
  const cached = new Map(place.serviceability.map((s) => [s.supplierId, s]));
  const usable: Supplier[] = [];
  const toProbe: Supplier[] = [];

  for (const s of suppliers) {
    const rec = cached.get(s.id);
    if (rec && isFresh(rec, nowMs)) {
      if (rec.serviceable) usable.push(s);
    } else {
      toProbe.push(s);
    }
  }

  const settled = await Promise.allSettled(toProbe.map((s) => s.checkServiceability(place)));
  const probed: Serviceability[] = [];
  settled.forEach((r, i) => {
    const supplier = toProbe[i]!;
    // A failed probe counts as "not serviceable now" but is not cached, so the next request retries.
    if (r.status !== 'fulfilled') return;
    const rec = { ...r.value, supplierId: supplier.id };
    probed.push(rec);
    cached.set(supplier.id, rec);
    if (rec.serviceable) usable.push(supplier);
  });

  // Keep the caller's supplier order.
  const order = new Map(suppliers.map((s, i) => [s.id, i]));
  usable.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { suppliers: usable, records: [...cached.values()], probed };
}
