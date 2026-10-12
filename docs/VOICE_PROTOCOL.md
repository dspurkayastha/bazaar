# Bazaar voice protocol (iPhone app ⇄ VPS gateway)

Decided 12 Oct 2026: voice-first, native iPhone app on the Action Button, Bengali/Hindi/English code-mixed speech, Sarvam for STT and TTS. Both the gateway (`src/voice/**`) and the app (`ios/**`) implement exactly this. Change it here first.

## Transport

`wss://bazaar.sciscribesolutions.com/voice` (local dev: `ws://127.0.0.1:8787/voice`).
Auth, on the upgrade request: HTTP header `Authorization: Bearer mtk_...` (member token), or — for the web app's Talk button — the `bz_session` cookie, accepted only when `Origin` equals `WEB_ORIGIN` (docs/WEB_API.md). Missing/invalid → close 4401. One live voice session per member; a second connection closes the first with 4409.

Two frame kinds:
- **Binary frames, app → server:** raw mic audio, PCM signed 16-bit little-endian, 16 000 Hz, mono, 20–40 ms per frame (640–1280 bytes). Sent continuously while the session is open, including while Bazaar is speaking (needed for barge-in; the app uses `AVAudioSession` mode `.voiceChat` so echo cancellation removes Bazaar's own voice).
- **Binary frames, server → app:** TTS audio, MP3 bytes for the current `audio_start` segment, in order. The app feeds them to a streaming MP3 player.
- **Text frames, both ways:** one JSON object per frame, with a `type` field. Unknown types are ignored.

## App → server control messages

| type | fields | meaning |
| --- | --- | --- |
| `hello` | `appVersion`, `device`, `locale` (e.g. `bn-IN`), `placeHint?` (place key/nickname if the user picked one) | first message after connect |
| `interrupt` | — | user tapped to stop Bazaar talking (voice barge-in is detected server-side too) |
| `cancel` | — | user said/tapped "cancel" on the pending cart; server clears the pending confirmation and any PIN request |
| `bye` | — | user ended the session (or 20 s of silence on the app side) |

## Server → app messages

| type | fields | meaning |
| --- | --- | --- |
| `ready` | `sessionId`, `member` {name, role}, `place` {key (the place's slug), nickname} | gateway connected to STT; app shows "listening" |
| `state` | `value`: `listening` \| `thinking` \| `speaking` | drives the orb and haptics |
| `heard` | `text`, `lang` (e.g. `bn-IN`), `final: true` | caption of what the user said (final transcript per turn) |
| `say` | `turnId`, `text` | caption of what Bazaar is saying (sent before its audio) |
| `audio_start` | `turnId`, `segment` (int), `codec: "mp3"`, `sampleRate` | the following binary frames belong to this segment |
| `audio_end` | `turnId`, `segment` | segment complete |
| `stop_audio` | `turnId` | stop playback NOW and drop queued audio (barge-in, interrupt, or superseded) |
| `cart` | `quote` {hash, supplier, place, lines[{name,label,qty,lineTotal}], fees[{label,amount}], total, etaMinutes}, `removed[]` | show/refresh the cart card. Amounts are integer paise |
| `decision` | `verdict` PAY\|HOLD\|BLOCK, `reasons[]`, `quoteHash`, `needsPin` (bool), `spokenConfirmation` (bool) | gate result. `needsPin: true` → the web app shows its PIN pad and calls `POST /api/carts/:quoteHash/approve {pin}`; on a phone call the owner types the PIN on the keypad |
| `order` | `supplierOrderId`, `status`, `etaMinutes?` | order placed |
| `error` | `code`, `message` (user-safe) | recoverable error; session stays open |

## Voice approvals (enforced on the server, never on the app)

- A spoken "yes / haan / hyan, order it" approves the pending held quote only when ALL hold: the speaker is an `owner` authenticated on this connection (member token or web session); Bazaar's previous turn spoke the total and asked for confirmation (state `awaiting_confirmation` for that exact quote hash); the quote total ≤ `PIN_REQUIRED_ABOVE_RUPEES` (default ₹500, exact paise); and less than 90 s have passed since the question.
- Above `PIN_REQUIRED_ABOVE_RUPEES`, the server sends `decision` with `needsPin: true` and the session waits in `awaiting_pin` (shown to the app as `listening`) for up to 5 minutes. A spoken yes is refused and the decision is sent again. The PIN arrives either from the web app's PIN pad (`POST /api/carts/:quoteHash/approve {pin}`, docs/WEB_API.md) or, on a phone call, from the keypad (DTMF → `verifyPinForApproval`). Wrong PINs count toward the lockout (5 → 15 min; 10 in 24 h → until reset). The PIN is never spoken, logged or sent over this socket. The gate still re-reads the cart and checks the hash.
- BLOCK verdicts are never approvable by voice or PIN.
- Adders can build carts by voice; their "yes" (and any keypad PIN) is ignored for payment and Bazaar says the owner will approve.
- There is no `needsBiometric` / Face ID approval any more: an `approve` message from an older app is an unknown type and is ignored.

## Speech behaviour

- Mirror the user's language mix. Bengali in Bengali script, Hindi in Devanagari, English words in Latin — Bulbul handles mixed scripts in one utterance. TTS `language_code` per turn = the dominant language STT reported for the user's last turn (bn-IN / hi-IN / en-IN).
- Short spoken sentences. Never read more than three items; summarise ("biryani-r sob jinish, curd ar ice cream").
- Speak money the way people say it ("এগারোশো তেইশ টাকা", "eleven twenty-three").
- When a tool call will take longer than ~1.2 s, play a short cached filler in the user's language ("ek second, dekhchi…").
- Never read ids, hashes, or addresses aloud; name the place by nickname.
