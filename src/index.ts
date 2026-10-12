/**
 * Boots the API.
 *
 *   BAZAAR_API_TOKEN   required; household READ token, /ledger/summary only (members use their own mtk_ tokens)
 *   WHATSAPP_WEBHOOK_SECRET  HMAC key the WhatsApp relay signs bodies with (x-bazaar-signature); unset = webhook off
 *   ANTHROPIC_API_KEY  required for /request (the agent loop); ANTHROPIC_MODEL optional (default claude-sonnet-5-5)
 *   DATABASE_URL       Postgres (needs BAZAAR_HOUSEHOLD_ID); unset = in-memory store seeded with the founding household
 *   BAZAAR_SUPPLIERS   comma list of supplier ids, default "stub"; e.g. "instamart" (needs TOKEN_ENC_KEY + pnpm auth:instamart)
 *   PORT / HOST        default 8787 / 127.0.0.1
 *   SARVAM_API_KEY     enables /voice (docs/VOICE_PROTOCOL.md); SARVAM_* and VOICE_APPROVAL_MAX_RUPEES tune it
 */
import 'dotenv/config';
import { MemoryStore } from './agent/memory-store.js';
import type { Store } from './agent/store.js';
import { anthropicClient } from './agent/llm.js';
import { issueMemberToken } from './api/auth.js';
import { buildServer } from './api/server.js';
import type { Supplier } from './core/types.js';
import { createDb } from './db/client.js';
import { foundingHousehold } from './db/seed-data.js';
import { DbStore } from './db/store.js';
import { getSupplier, type RegistryId } from './suppliers/registry.js';
import { voiceConfigFromEnv } from './voice/config.js';

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
    const memory = new MemoryStore([household]);
    store = memory;
    console.warn(
      `DATABASE_URL not set: using an in-memory store (household ${household.id}); state is lost on restart.`,
    );
    // Fresh member tokens every boot (nothing persists); printed once, only hashes are kept.
    console.warn('Member API tokens for this run (Authorization: Bearer ...):');
    for (const m of household.members) {
      console.warn(`  ${m.name} (${m.role}, ${m.id}): ${await issueMemberToken(memory, m.id)}`);
    }
  }

  const webhookSecret = process.env.WHATSAPP_WEBHOOK_SECRET ?? '';
  if (!webhookSecret) console.warn('WHATSAPP_WEBHOOK_SECRET not set: /webhooks/whatsapp will refuse every request.');

  const voice = voiceConfigFromEnv();
  if (!voice.sarvam) console.warn('SARVAM_API_KEY not set: /voice will answer voice_unconfigured and close.');

  const app = buildServer(
    {
      store,
      suppliers: await loadSuppliers(),
      llm: anthropicClient(),
      apiToken,
      ...(webhookSecret ? { webhookSecret } : {}),
      defaultHouseholdId,
      voice: { config: voice },
    },
    { logger: true },
  );
  const port = Number(process.env.PORT ?? 8787);
  await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
