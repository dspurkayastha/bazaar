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

## Voice

Voice-first mode: the iPhone app streams mic audio over `wss://…/voice` (contract: `docs/VOICE_PROTOCOL.md`); the gateway runs Sarvam STT (saaras:v4, code-mixed Bengali/Hindi/English), a conversational turn of the agent, and Sarvam TTS (Bulbul, MP3), sentence by sentence. A spoken "yes" can approve a held cart only for an owner, within 90 s of the question, up to `VOICE_APPROVAL_MAX_RUPEES` (default ₹2,000); above that the app asks for Face ID. BLOCK is never approvable.

Set `SARVAM_API_KEY` (and optionally the other `SARVAM_*` / `VOICE_*` vars in `.env.example`). Then try it with your own voice before the app exists (needs `ffmpeg` for anything but 16 kHz mono WAV: `brew install ffmpeg` / `sudo apt install ffmpeg`):

```sh
# Speech-to-text: streams the file to Sarvam in real time, prints each transcript with language, probability, latency
pnpm voice:test me.m4a                      # --mode codemix|transcribe|translit  --lang unknown|bn-IN|hi-IN|en-IN

# Text-to-speech: writes an MP3 and prints first-byte latency
pnpm voice:say "এগারোশো তেইশ টাকা। অর্ডার করে দিই?" --lang bn-IN -o out.mp3   # --speaker shubh  --model bulbul:v3|bulbul:v4-flash

# One full turn through the gateway in-process (real Sarvam + real agent, in-memory household, stub store):
pnpm voice:chat me.m4a -o reply.mp3         # --lang bn-IN  --place home  --stub | --live (real store per BAZAAR_SUPPLIERS)
```

`voice:chat` prints the captions (`heard`, `say`), the cart, the gate decision and the per-turn timings (`stt_final`, `llm_first_token`, `tts_first_audio`, `total`). It refuses a real store unless you pass `--live`, because the gate will place an order that is within the unattended limits.
