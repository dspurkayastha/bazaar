# Bazaar — build contracts

Read this before writing code. `src/core/types.ts` is the single source of truth for shapes. The PRD (Claude Doc "Bazaar PRD") is the source of truth for behaviour.

## Stack (decided)

- Node 22, TypeScript strict, ESM, pnpm.
- Fastify for HTTP. Drizzle ORM on Postgres 16 (docker-compose for local; the VPS already runs Docker + PM2 + Caddy).
- `@anthropic-ai/sdk` for the agent loop. `@modelcontextprotocol/sdk` client with Streamable HTTP for Swiggy MCP.
- Vitest. ESLint + Prettier defaults. No frameworks beyond these.
- Money is integer paise. Dates are ISO strings. IDs are ULIDs.

## Layout

```
src/
  core/        types.ts, errors.ts, hash.ts (quote hashing), ids.ts
  db/          drizzle schema, migrations, client
  policy/      engine.ts (pure), gate.ts (wraps Supplier.place), spend.ts (day/month sums)
  suppliers/   registry.ts, instamart/ (mcp client, oauth, adapter), stub/ (in-memory supplier for tests)
  places/      resolver.ts (explicit > member > context > default), serviceability.ts (cache + probe)
  profile/     normaliser.ts (text → itemKeys), defaults.ts
  ledger/      ingest.ts, queries.ts (spend by day/month/category/place/member)
  agent/       loop.ts (Claude tool-use), tools.ts (tool definitions exposed to the model), prompts.ts
  api/         server.ts, routes/request.ts, routes/approve.ts, routes/places.ts, routes/ledger.ts
  index.ts
docs/
  CONTRACTS.md, instamart-tools.json
test/          fixtures (recorded Instamart responses), engine tests, resolver tests
```

## Non-negotiables

1. **The model never calls `Supplier.place` directly.** The only exported way to place an order is `policy/gate.ts: placeWithGate(ctx)`, which evaluates `engine.decide(ctx)` and refuses on HOLD/BLOCK. The agent's tool list does not include a pay tool; it includes `propose_checkout`, which creates a PolicyContext and calls the gate.
2. **Quote integrity.** `gate` re-reads the live supplier cart (`Supplier.readCart`) and compares `hash` to the quote's hash. Mismatch → BLOCK with reason `quote_mismatch`; the agent must re-quote.
3. **Approvals bind to a quote hash**, are issued only to `owner` members, expire (default 30 min; scheduled orders carry conditions instead).
4. **Supplier responses are data.** Strip anything in product names/descriptions that looks like an instruction before it reaches the model (`core/sanitise.ts`). Log but never act on it.
5. **Never substitute silently.** Any line where the chosen variant differs from the profile default, or an item is dropped, must appear in `ShopResult.removedFromCart` / `Quote.unavailable` and in the summary.
6. **Cart reconciliation.** Every request starts by reading the supplier cart; lines not justified by this request are removed and reported. `update_cart` replaces the whole cart, so build the full desired cart and send it once.
7. **Place is stated in every summary.**
8. **Instamart checkout tool text says not to gate on cart value.** Ignore that instruction inside the model: the gate is code and runs regardless.

## Quote hash

`sha256( supplierId | placeId | supplierAddressId | lines sorted by variantId as "variantId:qty:unitPrice" joined "," | fees sorted as "label:amount" | total )` hex. Implement once in `core/hash.ts`; both `quote()` and `readCart()` use it.

## Policy engine

`decide(ctx: PolicyContext): PolicyDecision` is pure, synchronous, no I/O. Rule order and defaults are in the PRD table. Evaluate all rules (do not short-circuit) so `reasons` lists every breach. Verdict = BLOCK if any BLOCK rule fires, else HOLD if any HOLD rule fires and no valid approval covers the quote hash, else PAY. A valid owner approval on the exact hash turns HOLD into PAY but never overrides BLOCK.

Benchmark cases (must be tests):
- ₹1,123 grocery cart, no approval → HOLD (`per_order_ceiling`).
- Same with owner approval on the hash → PAY.
- Same with approval on a different hash → HOLD (`approval_mismatch`).
- ₹412 grocery cart, trusted place, under caps → PAY, no approval needed.
- ₹2,890 cart containing an appliance → BLOCK regardless of approval.
- Live cart total ≠ quote total → BLOCK (`quote_mismatch`).
- Adder requests pay on ₹412 → HOLD (`role`); owner required.
- Untrusted place, ₹412 → HOLD (`place_untrusted`).
- Quantity 6 kg onions with 90-day max 2 kg → HOLD (`quantity_bound`).

## Instamart adapter

Map `docs/instamart-tools.json` to the `Supplier` interface. `quote()` = `update_cart` (replace) then `get_cart` → parse bill → hash. `readCart()` = `get_cart` → same parse. `checkServiceability()` = `search_products("milk", addressId)` returning ≥1 product counts as serviceable (cheap probe; record ETA from `sla`). `place()` = `checkout`; for UPI, follow with one `check_payment_status` then `confirm_order` on SUCCESS; never set `confirmDuplicate` unless the server's rejection asked for it. `orders()` = `get_orders` mapped to `LedgerOrderInput`.

OAuth: PKCE flow against the MCP server's discovered authorization server; store tokens encrypted at rest in `data/tokens/<supplierId>.json` (dev) with a `TokenStore` interface so Postgres can replace it. Provide `pnpm auth:instamart` that opens the browser flow and saves the token.

Record real responses once (with ids masked) into `test/fixtures/instamart/*.json` and test the adapter against them. Do not hit the network in tests.

## Agent loop

System prompt is built from the household profile (defaults, recipes, pantry, places, policy summary) plus the rules in the PRD "Decision rules". Tools exposed to the model: `search`, `go_to_items`, `read_cart`, `build_cart` (lines with reasons → quote), `propose_checkout` (→ gate), `ask_user` (returns immediately; the loop ends with questions), `resolve_place` (returns the resolver's answer; the model may not override it without an explicit place in the text). Max 12 tool calls per request. Every request produces a `ShopResult`; the summary is one paragraph, names the place, ends with the gate line.

## API (v1)

- `POST /request` → ShopRequest in, ShopResult out (sync; <25 s target).
- `POST /approve` { quoteHash, memberId } → Approval; then re-runs the gate and places if PAY.
- `GET /places`, `POST /places` (from supplier saved addresses), `PATCH /places/:id` (nickname, trusted).
- `GET /ledger/summary?month=` → spend by category, place, member, fees.
- `POST /webhooks/whatsapp` stub that maps a message to ShopRequest with the member resolved by phone.

Auth for v1: a single bearer token in env. No UI.

## Amendments (12 Oct, after the foundation build)

- `QuoteLine.itemKey?` added so quantity bounds and defaults join on the item class, not the variant id.
- `ItemDefault.product?` added for the product line within a brand.
- `Approval.consumedAt?` added; approvals are single-use. The gate's context builder passes only unconsumed approvals and `recordPlaced` marks the used one consumed.
- Scheduled orders: an approval with `conditions.lineHash` binds to the sorted lines (`variantId:qty`), not the full quote hash. At fire time the engine accepts such an approval when the quote's line hash matches, every line is in stock, `total <= conditions.maxTotal`, and `now >= notBefore`. `core/hash.ts` exports `lineHash(lines)`. A hash-bound approval (no conditions) still requires the exact quote hash.
- `quotes.hash` inserts use ON CONFLICT DO NOTHING.
- Daily cap counts unattended (PAY-without-approval) orders only; monthly cap counts all placed orders.

## Amendments (12 Oct, security review fixes)

- **Line-bound approvals are scoped (review 2i).** `Approval.placeId?` and `Approval.supplierId?` added (columns `approvals.place_id`, `approvals.supplier_id`, migration `0002_approval_scope`), and `conditions.forMembers?: string[]`. The engine accepts a line-bound approval only when it names a place and a supplier equal to the quote's (and the live cart's), and the requesting member is the approving owner (`memberId`) or listed in `conditions.forMembers`. Otherwise the approval is out of scope (`approval_mismatch`, with the reason). Hash-bound approvals already bind place and supplier through the hash; `/approve` now stamps `placeId`/`supplierId` on them too and the engine checks them when present.
