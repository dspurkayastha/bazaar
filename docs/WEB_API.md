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
