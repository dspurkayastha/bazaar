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

The server serves `web/dist` at the site root. It needs an SPA fallback for `GET /setup/*` (return `index.html`); every other screen is a `#hash` tab, so no other fallback is required. Never cache `/api` or `/voice`. `sw.js` must be served from `/` with `Cache-Control: no-cache`.

## Layout

- `src/api.ts` fetch wrapper: `X-Bazaar: 1` on every non-GET, 401 returns to sign-in, friendly 403/423/5xx messages.
- `src/voice/reducer.ts` pure reducer for every server message (`state x message -> state`).
- `src/voice/resample.ts` pure resampler (any rate to 16 kHz), Int16 conversion and 40 ms framer.
- `src/voice/session.ts` mic, WebSocket and `AudioContext` wiring; `player.ts` queues MP3 segments.
- `public/pcm-capture.js` the AudioWorklet that hands mic blocks to the main thread.
- `src/components/CartCard.tsx` the receipt-style cart, shared by Carts and Talk.
- `src/components/PinPad.tsx` the PIN pad (4 to 6 digits).

## Installing on iPhone

Open the site in Safari, Share, Add to Home Screen. Passkeys and the microphone only work on https (or localhost).
