# Bazaar

Household procurement agent: one voice, every quick-commerce store, a hard money gate, and a ledger the stores never give you.

The model proposes; code decides. Every checkout passes through a deterministic policy engine (`src/policy/engine.ts`) wrapped by the gate (`src/policy/gate.ts`), which re-reads the live supplier cart, checks the quote hash, and only then calls `Supplier.place`.

Start with `docs/CONTRACTS.md` and `src/core/types.ts`.

## Run

Requires Node 22 and pnpm.

```sh
pnpm install
cp .env.example .env          # fill in keys
docker compose up -d          # Postgres 16 on 127.0.0.1:${BAZAAR_PG_PORT:-5433}
pnpm db:migrate               # apply drizzle/ migrations
pnpm db:seed                  # founding household
pnpm test                     # vitest, no network, no database
pnpm lint
```

`pnpm db:generate` regenerates SQL migrations from `src/db/schema.ts` (no database needed).

Money is integer paise throughout; IDs are ULIDs; times are ISO strings.
