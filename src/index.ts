/**
 * Boots the API.
 *
 *   BAZAAR_API_TOKEN   required; bearer token for every route but /health
 *   ANTHROPIC_API_KEY  required for /request (the agent loop); ANTHROPIC_MODEL optional
 *   DATABASE_URL       Postgres (needs BAZAAR_HOUSEHOLD_ID); unset = in-memory store seeded with the founding household
 *   BAZAAR_SUPPLIERS   comma list of supplier ids, default "stub"; e.g. "instamart" (needs TOKEN_ENC_KEY + pnpm auth:instamart)
 *   PORT / HOST        default 8787 / 127.0.0.1
 */
import 'dotenv/config';
import { MemoryStore } from './agent/memory-store.js';
import type { Store } from './agent/store.js';
import { anthropicClient } from './agent/llm.js';
import { buildServer } from './api/server.js';
import type { Supplier } from './core/types.js';
import { createDb } from './db/client.js';
import { foundingHousehold } from './db/seed-data.js';
import { DbStore } from './db/store.js';
import { getSupplier, type RegistryId } from './suppliers/registry.js';

async function loadSuppliers(): Promise<Supplier[]> {
  const ids = (process.env.BAZAAR_SUPPLIERS ?? 'stub')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as RegistryId[];
  return ids.map((id) => getSupplier(id));
}

async function main(): Promise<void> {
  const apiToken = process.env.BAZAAR_API_TOKEN ?? '';
  if (!apiToken) throw new Error('BAZAAR_API_TOKEN is not set (see .env.example)');

  let store: Store;
  let defaultHouseholdId: string;
  if (process.env.DATABASE_URL) {
    defaultHouseholdId = process.env.BAZAAR_HOUSEHOLD_ID ?? '';
    if (!defaultHouseholdId) throw new Error('BAZAAR_HOUSEHOLD_ID is required with DATABASE_URL');
    store = new DbStore(createDb().db);
  } else {
    const household = foundingHousehold();
    defaultHouseholdId = household.id;
    store = new MemoryStore([household]);
    console.warn(
      `DATABASE_URL not set: using an in-memory store (household ${household.id}); state is lost on restart.`,
    );
    console.warn(`Owner member id: ${household.members.find((m) => m.role === 'owner')!.id}`);
  }

  const app = buildServer(
    { store, suppliers: await loadSuppliers(), llm: anthropicClient(), apiToken, defaultHouseholdId },
    { logger: true },
  );
  const port = Number(process.env.PORT ?? 8787);
  await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
