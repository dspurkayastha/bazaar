# Bazaar

Household procurement agent: one voice, every quick-commerce store, a hard money gate, a ledger the stores never give you.

Read `docs/CONTRACTS.md` first, then `src/core/types.ts`. Do not change types without updating CONTRACTS.md.

- pnpm, Node 22, TS strict, ESM, Vitest. `pnpm test` must pass before you stop.
- Money is integer paise. Never floats for money.
- The model never places orders. Only `src/policy/gate.ts` may call `Supplier.place`.
- No network in tests; use `test/fixtures`.
- Keep commits small with clear messages. Do not push.
