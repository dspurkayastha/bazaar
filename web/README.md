# Bazaar web app

The screen for Bazaar: carts to approve, a Talk button for the voice agent, the ledger, and household settings. Vite + TypeScript + Preact, hand-written CSS, no UI kit. Contract: `docs/WEB_API.md` and `docs/VOICE_PROTOCOL.md`.

This is a standalone package with its own `pnpm-lock.yaml` (the repo root is not a pnpm workspace).

## Develop

```sh
pnpm --dir web install
pnpm --dir web dev        # http://localhost:5173, proxies /api and /voice to 127.0.0.1:8787
pnpm --dir web test       # vitest + testing-library
pnpm --dir web build      # type-checks, then writes web/dist
pnpm --dir web icons      # re-renders the PNG icons from public/icon.svg
```

Run the Bazaar server on port 8787 with `WEB_ORIGIN=http://localhost:5173` and `WEBAUTHN_RP_ID=localhost` so passkeys work in dev. The dev server is http://localhost, which browsers treat as a secure context, so passkeys and the microphone are available.

## Serving it

Production is a Cloudflare Worker with static assets (`wrangler.toml`, `worker/index.ts`): it serves `dist/` with an SPA fallback and forwards `/api/*` and `/voice` to the VPS through a Cloudflare Tunnel, so the browser sees one origin (cookies, CSP, passkey RP ID and the `/voice` Origin check stay as they were). Set-up: `deploy/cloudflare.md`. `public/_headers` carries the CSP and cache headers for the static files; keep it equal to `src/api/static.ts` (`test/web-headers.test.ts` checks).

```sh
pnpm --dir web test                       # includes the Worker unit tests (test/worker.test.ts)
pnpm --dir web exec wrangler deploy --dry-run   # validates wrangler.toml and bundles the Worker, no login
```

The Bazaar server can still serve `web/dist` itself (`pnpm web:build`; SPA fallback for `GET /setup/*`), which is what local dev against the built app uses. Never cache `/api` or `/voice`. `sw.js` must be served from `/` with `Cache-Control: no-cache`.

`wrangler` is pinned exactly in `package.json`. Secret `EDGE_SECRET` is set with `npx wrangler secret put EDGE_SECRET` or in the dashboard (Settings, Variables and Secrets); never put it in `wrangler.toml`.

## Preview (sample) mode

On any host that is not `bazaar.sciscribesolutions.com`, `localhost` or `127.0.0.1` (Cloudflare branch previews, `*.workers.dev`) the app runs on sample data: no fetch at all, a "Preview — sample data" banner, a "Preview only" toast on every action, and Talk plays a scripted exchange without a microphone. It is all in `src/sample/`, switched in at `src/api.ts` (and `createVoiceSession` for Talk), so screens do not branch. `fixtures.ts` is the data (two held carts, one from the partner over ₹500; recent orders; a ledger month; four members including the Guwahati family; five places). To look at it locally, open the dev server by a non-local hostname (`pnpm --dir web dev --host`, then `http://<your-lan-ip>:5173`) or temporarily change `isSampleMode` in `src/sample/mode.ts`.

## Layout

- `worker/index.ts` the Cloudflare Worker (forwarder); `src/sample/` preview mode.
- `src/api.ts` fetch wrapper: `X-Bazaar: 1` on every non-GET, 401 returns to sign-in, friendly 403/423/5xx messages.
- `src/voice/reducer.ts` pure reducer for every server message (`state x message -> state`).
- `src/voice/resample.ts` pure resampler (any rate to 16 kHz), Int16 conversion and 40 ms framer.
- `src/voice/session.ts` mic, WebSocket and `AudioContext` wiring; `player.ts` queues MP3 segments.
- `public/pcm-capture.js` the AudioWorklet that hands mic blocks to the main thread.
- `src/components/CartCard.tsx` the receipt-style cart, shared by Carts and Talk.
- `src/components/PinPad.tsx` the PIN pad (4 to 6 digits).

## Installing on iPhone

Open the site in Safari, Share, Add to Home Screen. Passkeys and the microphone only work on https (or localhost).
