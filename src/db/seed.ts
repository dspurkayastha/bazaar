/** pnpm db:seed — inserts the founding household once (skips if a household with that name exists). */
import { eq } from 'drizzle-orm';
import { newId } from '../core/ids.js';
import { createDb } from './client.js';
import { households, itemDefaults, members, places, profiles } from './schema.js';
import { foundingHousehold } from './seed-data.js';

const h = foundingHousehold();
const { db, close } = createDb();

try {
  const existing = await db.select({ id: households.id }).from(households).where(eq(households.name, h.name));
  if (existing.length > 0) {
    console.log(`household "${h.name}" already seeded (${existing[0]!.id}); nothing to do`);
  } else {
    await db.transaction(async (tx) => {
      await tx.insert(households).values({ id: h.id, name: h.name, policy: h.policy });
      await tx.insert(members).values(h.members.map((m) => ({ ...m, defaultPlaceId: m.defaultPlaceId ?? null })));
      await tx.insert(places).values(
        h.places.map((p) => ({
          ...p,
          lat: p.lat ?? null,
          lng: p.lng ?? null,
          profileOverlay: p.profileOverlay ?? null,
        })),
      );
      const { defaults, householdId: _hid, ...stored } = h.profile;
      await tx.insert(profiles).values({ householdId: h.id, profile: stored });
      await tx.insert(itemDefaults).values(
        defaults.map((d) => ({
          id: newId('item'),
          householdId: h.id,
          key: d.key,
          aliases: d.aliases,
          brand: d.brand ?? null,
          product: d.product ?? null,
          size: d.size ?? null,
          quantityPerHead: d.quantityPerHead ?? null,
          category: d.category,
          neverSubstitute: d.neverSubstitute ?? false,
          supplierHints: d.supplierHints ?? null,
          origin: d.origin,
        })),
      );
    });
    console.log(`seeded household "${h.name}" (${h.id}): ${h.members.length} members, ${h.places.length} places`);
  }
} finally {
  await close();
}
