# Bazaar web app ⇄ server contract

Decided 12 Oct 2026 (see PRD "Voice-first front end"). The web app is served by Bazaar itself at `https://bazaar.sciscribesolutions.com/` and is the screen; voice reaches Bazaar by phone (provider deferred) or by the web app's Talk button over `/voice` (docs/VOICE_PROTOCOL.md). Money is integer paise in every payload. All routes below are same-origin JSON.

## Identity

- Members: owner (Dev), adders (partner, Guwahati family), dependants. Each member has `phones[]` (E.164, used for caller ID on calls) and optional `defaultPlaceId`.
- **Web sign-in = passkey (WebAuthn, Face ID in Safari).** A member gets a **one-time setup link** created by the owner: `/setup/<code>` (code: 32 random bytes base64url, stored hashed, single use, expires in 48 h). Opening it registers a passkey for that member. After that, sign-in is passkey only.
- Session: `HttpOnly; Secure; SameSite=Strict` cookie `bz_session` (opaque, stored hashed server-side, 30-day sliding expiry). CSRF: every non-GET request must send header `X-Bazaar: 1` (custom header + SameSite=Strict).
- `mtk_` bearer tokens keep working for API/CLI use; the web app never sees them.
- RP ID `bazaar.sciscribesolutions.com`; for local dev `localhost`. Origin and RP ID from env (`WEB_ORIGIN`, `WEBAUTHN_RP_ID`).

## PIN

- Owner sets a 4–6 digit PIN (web: Household → Security). Stored with scrypt (N=2^15, per-PIN salt). Never logged, never returned.
- Required to approve any held quote whose total > ₹500 (`PIN_REQUIRED_ABOVE_RUPEES`, default 500), on every channel: keypad (DTMF) on a call, or the web app. Under that, an owner's spoken or tapped yes is enough (and policy may already pay unattended).
- Lockout: 5 wrong PINs → PIN approvals disabled for 15 min for that member (and an event recorded in the ledger); 10 within 24 h → disabled until the owner resets from a signed-in web session with a fresh passkey assertion.
- BLOCK verdicts are never approvable by PIN.

## Routes

| Method | Path | Auth | Body → Response |
| --- | --- | --- | --- |
| GET | `/api/me` | session | → `{member:{id,name,role}, household:{id,name}, pinSet:bool, pinLocked:bool}` or 401 |
| POST | `/api/setup/:code/options` | none (code) | → WebAuthn registration options, `{member:{name}}` |
| POST | `/api/setup/:code/verify` | none (code) | registration response → sets session cookie, `{ok:true}` |
| POST | `/api/login/options` | none | → WebAuthn authentication options (discoverable credentials) |
| POST | `/api/login/verify` | none | assertion → sets session cookie, `{ok:true}` |
| POST | `/api/logout` | session | → `{ok:true}`, clears cookie |
| GET | `/api/carts` | session | → `{held:[HeldCart], recent:[OrderSummary]}` — owner sees every member's held carts; others see their own |
| POST | `/api/carts/:quoteHash/approve` | session (owner) | `{pin?}` → `{decision, order?, needsPin?, pinLocked?}`; re-runs the gate; PIN required if total > threshold |
| POST | `/api/carts/:quoteHash/reject` | session (owner, or the member who built it) | → `{ok:true}`; clears the supplier cart if it is still that quote |
| GET | `/api/ledger?month=YYYY-MM` | session | → existing ledger summary (owner: whole household; others: their own lines) |
| GET | `/api/household` | session | → `{members:[{id,name,role,phones[],defaultPlaceId,hasPasskey}], places:[{id,key,nickname,aliases,city,trusted,isDefault,supplierAddressIds,serviceability}]}` |
| POST | `/api/household/members` | session (owner) | `{name, role, phones[], defaultPlaceId?}` → member |
| PATCH | `/api/household/members/:id` | session (owner) | partial → member |
| POST | `/api/household/members/:id/setup-link` | session (owner) | → `{url, expiresAt}` (shown once) |
| POST | `/api/household/places` | session (owner) | `{nickname, aliases[], city, instamartAddressId?, trusted?, isDefault?}` → place |
| PATCH | `/api/household/places/:id` | session (owner) | partial → place |
| GET | `/api/household/supplier-addresses` | session (owner) | → Instamart saved addresses not yet mapped to a place (for one-tap import) |
| POST | `/api/pin` | session (owner) + fresh passkey assertion (`assertion` in body) | `{pin, assertion}` → `{ok:true}` |

`HeldCart = {quoteHash, member:{id,name}, place:{id,nickname}, supplier, lines:[{name,label,qty,lineTotal}], fees:[{label,amount}], total, etaMinutes?, createdAt, reasons:[string], needsPin:bool, approvable:bool}`
`OrderSummary = {supplierOrderId, placedAt, place, total, status, member}`

Errors: `{error:{code, message}}` with HTTP 400/401/403/404/409/423 (423 = PIN locked).

## Voice from the web app

`/voice` additionally accepts the `bz_session` cookie on the WebSocket upgrade (same-origin only; check `Origin`). In a web voice session, a held quote above the PIN threshold produces `decision` with `needsPin: true` (replacing `needsBiometric`), and the app shows a PIN pad that calls `POST /api/carts/:quoteHash/approve`.

## Server behaviour in detail (as implemented, 12 Oct)

Additive notes for the frontend; nothing here changes the table above.

- **Setup options** answer the WebAuthn `PublicKeyCredentialCreationOptionsJSON` with one extra key: `{...options, member:{name}}` (pass the whole object to `startRegistration({optionsJSON})`; the extra key is ignored). Resident key and user verification are required. An unknown, used, revoked (a newer link was made) or expired code → 404 `setup_invalid`; a code consumed by a parallel request → 409 `setup_used`.
- **Setup verify / login verify** take the `RegistrationResponseJSON` / `AuthenticationResponseJSON` from `@simplewebauthn/browser` as the body. Success sets `bz_session=…; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`. Challenges are single use and live 5 minutes (`challenge_expired`, 400 on setup, 401 on login). Failures: `registration_failed`, `assertion_failed`, `unknown_passkey`.
- **Sessions slide**: a request on a session older than 5 minutes since its last use extends it to 30 days from now and re-sends the cookie. 401 body: `{error:{code:'unauthorised'}}`.
- **CSRF**: a non-GET `/api/*` without `X-Bazaar: 1` → 403 `csrf` (checked before authentication, so also on `/api/login/*` and `/api/setup/*`).
- **`/api/me`** may add `pinLockedUntil` (ISO) during a 15-minute lock.
- **`POST /api/pin`**: get the assertion exactly as for sign-in — `POST /api/login/options`, `startAuthentication`, then send `{pin, assertion}`. Errors: `pin_invalid` (400, not 4–6 digits), `assertion_required` (400), `challenge_expired` / `assertion_failed` (401), `assertion_mismatch` (403, a different member's passkey), `owner_required` (403). Setting a PIN also clears any lock (this is the reset).
- **Approve** `{pin?}` answers 200 `{decision, order?, needsPin?, alreadyPlaced?, requote?}`:
  - total above the threshold and no `pin` → `{decision:{verdict:'HOLD', reasons:[{rule:'pin_required',…}]}, needsPin:true}`; nothing is approved;
  - wrong PIN → 403 `{error:{code:'pin_incorrect'}, attemptsLeft}`; no PIN set → 409 `pin_not_set`; malformed → 400 `pin_invalid`;
  - locked → 423 `{error:{code:'pin_locked'}, pinLocked:true, hardLocked, lockedUntil?}` (also on the attempt that triggers the lock);
  - otherwise the gate's verdict; `order` is present when it was placed (or had already been placed: `alreadyPlaced`); `requote:true` when the cart changed at the store. Non-owner → 403 `owner_required`.
- **Reject** answers `{ok:true, cleared}`: `cleared` says whether the supplier cart still held that exact quote and was emptied. It also voids any live owner approval for that hash. Only an owner or the member whose request built the cart (403 otherwise).
- **Held carts** are carts whose newest gate decision (on the current quote, within 24 h) is HOLD, or BLOCK for a reason other than a changed cart, not placed and not rejected. `reasons` are the gate's human-readable details. `approvable` = viewer is an owner and the verdict is HOLD. `recent` = up to 20 orders from the last 30 days (owner: household; others: their own); `place`/`member` may be `null` for orders placed outside Bazaar.
- **Ledger** for non-owners: orders they placed in full, plus only their own lines of other orders (no fees).
- **Members**: `role` defaults to `adder`; `phones` are normalised (spaces, dashes, dots, brackets removed) and must be E.164 (`bad_phone`); a phone already on another member → 409 `phone_taken`; at most 5 per member. `defaultPlaceId: null` clears it. Demoting the last owner → 409 `last_owner`. Responses use the `GET /api/household` member shape.
- **Places**: `key` is a slug of the first nickname ("Rahul's" → `rahuls`) and never changes. With `instamartAddressId`, the canonical address is taken from that saved address (400 `bad_address` if Instamart does not list it; 409 `address_taken` if a place already uses it). Duplicate nickname → 409 `nickname_taken`. PATCH accepts `nickname, aliases, city, trusted, isDefault:true, instamartAddressId|null`. Responses use the `GET /api/household` place shape.
- **Supplier addresses** answer `{addresses:[{id, tag, category, addressLine}], available}`; `available:false` (empty list) when Instamart is not configured. Phone numbers are never included.
- **Static app**: `/assets/*` is `Cache-Control: public, max-age=31536000, immutable`; `index.html` and other root files `no-cache`. Every response carries `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' wss://<host>; … frame-ancestors 'none'; object-src 'none'` — no inline `<script>`/`<style>` blocks or `style=""` attributes in the HTML (setting styles from JS, e.g. React's `style` prop, is fine), no `data:` images, no third-party hosts (fonts and icons must be bundled).
