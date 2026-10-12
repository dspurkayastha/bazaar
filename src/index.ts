/**
 * Boots the API.
 *
 *   BAZAAR_API_TOKEN   required; bearer token for every route but /health
 *   ANTHROPIC_API_KEY  required for /request (the agent loop); ANTHROPIC_MODEL optional
 *   DATABASE_URL       Postgres (needs BAZAAR_HOUSEHOLD_ID); unset = in-memory store seeded with the founding household
 *   BAZAAR_SUPPLIERS   "stub" (default for now) or "registry" (src/suppliers/registry.ts exporting createSuppliers())
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
import { StubSupplier } from './suppliers/stub/index.js';

async function loadSuppliers(): Promise<Supplier[]> {
  const mode = process.env.BAZAAR_SUPPLIERS ?? 'stub';
  if (mode === 'stub') return [new StubSupplier()];
  if (mode === 'registry') {
    const path = './suppliers/registry.js';
    const mod = (await import(path)) as { createSuppliers?: () => Supplier[] | Promise<Supplier[]> };
    if (typeof mod.createSuppliers !== 'function')
      throw new Error('suppliers/registry.js must export createSuppliers()');
    return mod.createSuppliers();
  }
  throw new Error(`BAZAAR_SUPPLIERS must be "stub" or "registry", got ${mode}`);
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
