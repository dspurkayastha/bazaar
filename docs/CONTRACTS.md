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
  voice/       config.ts, sarvam.ts (STT/TTS clients), sentences.ts, fillers.ts, session.ts, connection.ts, route.ts (/voice), cli.ts
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

System prompt is built from the household profile (defaults, recipes, pantry, places, policy summary) plus the rules in the PRD "Decision rules". Tools exposed to the model: `search`, `search_many` (1-12 queries in parallel, top 5 products each, per-query errors), `go_to_items`, `read_cart`, `build_cart` (lines with reasons → quote), `propose_checkout` (→ gate), `ask_user` (returns immediately; the loop ends with questions), `resolve_place` (returns the resolver's answer; the model may not override it without an explicit place in the text). Max 20 tool calls and 60 s wall time per request; read-only calls in one model turn run concurrently and all results come back in one message. `build_cart` failures return `{ error: { kind: 'supplier'|'quote_mismatch'|'invalid_line', message } }`; the same kind+message twice ends the loop. When the loop ends abnormally (budget, wall time, repeated error, LLM failure, a final message that ends mid-plan) the summary is built by code ("For <place>: I couldn't build the cart — <reason>. Nothing was ordered."), never from the model's text, and an unproposed cart is not auto-submitted. Each request logs one `shop_request` line (requestId, placeId, model, toolCalls[{name, ms, ok, errorKind?, errorMessage?}], totalMs, outcome, usage); `x-bazaar-debug: 1` on `POST /request` adds the same trace under `debug`. Every request produces a `ShopResult`; the summary is one paragraph, names the place, ends with the gate line.

## API (v1)

- `POST /request` → ShopRequest in, ShopResult out (sync; <25 s target).
- `POST /approve` { quoteHash } → Approval (approver = the token's member); then re-runs the gate and places if PAY.
- `GET /places`, `POST /places` (from supplier saved addresses), `PATCH /places/:id` (nickname, trusted).
- `GET /ledger/summary?month=` → spend by category, place, member, fees.
- `POST /webhooks/whatsapp` stub that maps a message to ShopRequest with the member resolved by phone.

Auth for v1: ~~a single bearer token in env~~ superseded, see Amendments (security review fixes): per-member tokens, household read token, signed webhook. No UI.

## Amendments (12 Oct, after the foundation build)

- `QuoteLine.itemKey?` added so quantity bounds and defaults join on the item class, not the variant id.
- `ItemDefault.product?` added for the product line within a brand.
- `Approval.consumedAt?` added; approvals are single-use. The gate's context builder passes only unconsumed approvals and `recordPlaced` marks the used one consumed.
- Scheduled orders: an approval with `conditions.lineHash` binds to the sorted lines (`variantId:qty`), not the full quote hash. At fire time the engine accepts such an approval when the quote's line hash matches, every line is in stock, `total <= conditions.maxTotal`, and `now >= notBefore`. `core/hash.ts` exports `lineHash(lines)`. A hash-bound approval (no conditions) still requires the exact quote hash.
- `quotes.hash` inserts use ON CONFLICT DO NOTHING.
- Daily cap counts unattended (PAY-without-approval) orders only; monthly cap counts all placed orders.

## Amendments (12 Oct, security review fixes)

- **Line-bound approvals are scoped (review 2i).** `Approval.placeId?` and `Approval.supplierId?` added (columns `approvals.place_id`, `approvals.supplier_id`, migration `0002_approval_scope`), and `conditions.forMembers?: string[]`. The engine accepts a line-bound approval only when it names a place and a supplier equal to the quote's (and the live cart's), and the requesting member is the approving owner (`memberId`) or listed in `conditions.forMembers`. Otherwise the approval is out of scope (`approval_mismatch`, with the reason). Hash-bound approvals already bind place and supplier through the hash; `/approve` now stamps `placeId`/`supplierId` on them too and the engine checks them when present.
- **Gate runs are serialised per household (review 5a, 5c).** `policy/lock.ts` defines `GateLock { run(householdId, critical) }`. `MemoryGateLock` is an in-process single flight (promise chain keyed by householdId; `processGateLock` is the shared default). `db/lock.ts` `PgGateLock` takes `pg_advisory_xact_lock(hashtext(householdId))` in a transaction and publishes it via AsyncLocalStorage; DbStore and DbDecisionRecorder run every query on that transaction while it is active. `Store.gateLock?` supplies the lock; `placeWithGate({ lock })` defaults to `processGateLock`. Inside the lock the gate checks idempotency, reads the live cart, builds the context (callers use `loadingContextBuilder`, which loads approvals, spend and quantity history in `build()`, i.e. under the lock), decides, records, places and records the order. HOLD/BLOCK are returned out of the critical section and thrown after it, so the recorded decision commits. Trade-off: on Postgres the decision row commits with the critical section, not before `place()`; a crash between place() and commit loses the rows and ledger ingest reconciles the order.
- **Placement is idempotent per quote.** `DecisionRecorder.findPlaced?(householdId, quote)` returns the order already placed for this quote hash at or after `quote.createdAt` (not failed/cancelled). The gate returns it (`GateResult.replayed = true`) without calling the supplier. `/approve` reports a replay as `placed: false, alreadyPlaced: true` with that order and its original decision; `propose_checkout` returns `alreadyPlaced: true`. To keep "an identical cart bought again later" a new purchase, a re-quote of the same hash now **replaces** the stored quote when its createdAt is newer (supersedes "quotes.hash inserts use ON CONFLICT DO NOTHING": it is now ON CONFLICT DO UPDATE ... WHERE newer).
- **Member identity is a credential, not a body field (review 4h).** Each member has an API token `mtk_<43 base64url>` (256 random bits); only `sha256(token)` hex is stored (`member_credentials`, migration `0003_member_credentials`; `MemoryStore.credentials`). `Store.findMemberByTokenHash` / `Store.rotateMemberCredential` added. `/request`, `/approve` and `/places` take `Authorization: Bearer <member token>`; member and household come from the token and any body `memberId` / `householdId` is ignored. `BAZAAR_API_TOKEN` is now only the household read token for `GET /ledger/summary`; `/health` is open; routes declare `config.auth` and default to member auth. Tokens are issued (printed once) by `pnpm db:seed` and by the in-memory boot, and issued/rotated with `pnpm member:token <memberId>` (a new token revokes the member's previous ones).
- **WhatsApp webhook is signed (review 4h).** `POST /webhooks/whatsapp` requires `x-bazaar-signature: sha256=<hex>`, HMAC-SHA256 of the raw body with `WHATSAPP_WEBHOOK_SECRET`, verified in the route's body parser before the JSON is parsed (missing/wrong → 401; no secret configured → 503). Only then is `from` mapped to a member (unknown → 403). A webhook request can only create a shop request: it never approves and approvals never apply to it. `Member.channels[].trusted?: boolean` added; `PolicyContext.webhook?: { channel, trusted }` added. The engine HOLDs a webhook request (`channel_untrusted`) unless it comes from an owner's channel with `trusted: true` (the seed sets it for Dev's WhatsApp), and evaluates no approvals when `webhook` is set.
- **Hash-bound approvals cover owners only.** A hash-bound approval is valid only when the requesting member is the approving owner or another owner of the household; an adder's identical cart is HELD (`role`, `approval_mismatch`) even with a live owner approval on the exact hash. (Line-bound approvals keep `forMembers` for delegating to named members.)
- **A replayed `/approve` consumes its approval.** When a repeat `/approve` resolves as an idempotent replay, the approval it created is marked consumed (`Store.consumeApproval`), so no live unconsumed approval remains for an already-placed quote.

## Amendments (12 Oct, voice-first mode)

Server side of docs/VOICE_PROTOCOL.md. Nothing new on the money path: approvals and placement still go through `approveQuote` (the `/approve` code) and `placeWithGate`.

- **`ShopRequest.channel` gains `'voice'`.** Each spoken turn is saved as a ShopRequest with channel `voice` (text = the final transcript), so quotes built in that turn reference it.
- **`LlmClient.stream?(req, onText)`** (optional) streams text deltas; `anthropicClient` implements it with `messages.stream`. Aborting `req.signal` stops generation.
- **Conversational mode: `agent/conversation.ts` `runConversationTurn(session, userText, lang, deps, hooks)`.** Reuses the shop tools and the gate; keeps history per `ConversationState` (last 20 turns; the session drops it after 10 min idle), the place (kept across turns, switched only by an explicit mention, decided by the resolver), the variants already shown and the quotes already built. Voice system prompt = the household prompt + `buildVoiceSystemPrompt` "Speech behaviour" rules. Tools: the shop tools minus `ask_user` (questions are spoken), plus `confirm_pending_order`. A cart the model built but did not propose is NOT auto-proposed in voice mode (in a conversation it may be a draft); the gate still runs on every propose. Model or tool failure ends the turn with a fixed, code-written phrase in the turn language ("… Nothing was ordered").
- **Voice approvals are code (`checkVoiceApproval`).** After `propose_checkout` returns HOLD for an owner, the server (not the model) records `PendingConfirmation { quoteHash, total, askedAt, needsBiometric }` at the end of that turn. It is valid for the very next turn only. `confirm_pending_order { quoteHash }` approves only when: the member is an `owner`; the session is attached to a connection authenticated with that member's token; the pending hash equals the given hash; `now − askedAt < 90 s`; `total ≤ VOICE_APPROVAL_MAX_RUPEES × 100` (exact paise). Refusals: `owner_required`, `unauthenticated`, `nothing_pending`, `wrong_quote`, `too_late` (re-arms the question; the reply must say the total again), `needs_biometric` (sends `decision.needsBiometric: true`). A question cut off by barge-in is not pending. BLOCK never creates a pending confirmation. An adder's held cart creates none either (their yes is ignored; `decision.spokenConfirmation: false`).
- **Face ID approvals.** `approve { quoteHash, biometric: true }` is accepted only from an owner on the authenticated connection, for the hash the server itself sent with `needsBiometric: true` (kept for 5 min across turns; cleared by `cancel`, a new connection or use). It calls `approveQuote`, which re-reads the live cart in the gate.
- **`decision.reasons`** are `{ rule, detail }` objects (the engine's reasons). `cart.removed` is `[{ name, qty }]`. `ready.place.key` is the place id.
- **`/voice` close codes:** 4401 unauthorised (socket accepted, then closed: the auth hook does not 401 the upgrade), 4409 superseded, 1011 `voice_unconfigured` (no SARVAM_API_KEY) or STT unavailable, 1008 no `hello` within 10 s, 1000 after `bye`.
- **Turn mechanics.** Turns run one at a time per connection; a new final transcript while a turn runs supersedes it. Barge-in (STT `START_SPEECH` while speaking) and `interrupt`: `stop_audio`, TTS socket closed, model call aborted; a running tool call is never aborted (it finishes and is recorded in the history). Reply text is split on `।` `?` `!` newline and `. ` and each sentence goes to TTS as soon as it is complete; each sentence is one segment (`say` → `audio_start` → MP3 frames → `audio_end`). Fillers: three per language, synthesised at first use per (model, speaker, language) and cached in memory; one plays if a tool call runs past 1.2 s and nothing has been said yet.
- **Trace:** one `voice_turn` info line per turn (`VoiceTurnTelemetry`: sessionId, turnId, lang, model, sttFinalMs, llmFirstTokenMs, ttsFirstAudioMs, totalMs, toolCalls, outcome, filler?, interrupted?, usage?). Transcripts are logged only at debug level (`voice_heard`); no reply text, keys, tokens or phone numbers. Sarvam error frames and refusals are logged verbatim (`raw`).
- **HTTP rate limit:** `@fastify/rate-limit`, 60 requests/min per bearer token (per IP without one), applied before authentication; `/health` exempt. Over the limit → 429.
- **Env:** `SARVAM_API_KEY`, `SARVAM_STT_MODE` (default codemix), `SARVAM_STT_LANGUAGE` (default unknown), `SARVAM_TTS_MODEL` (default bulbul:v3), `SARVAM_SPEAKER_BN/HI/EN` (default shubh), `VOICE_APPROVAL_MAX_RUPEES` (default 2000). Pinned: `ws` 8.21.3, `@fastify/websocket` 11.3.1, `@fastify/rate-limit` 11.2.0.
