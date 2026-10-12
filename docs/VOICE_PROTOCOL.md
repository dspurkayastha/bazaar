# Bazaar voice protocol (iPhone app ⇄ VPS gateway)

Decided 12 Oct 2026: voice-first, native iPhone app on the Action Button, Bengali/Hindi/English code-mixed speech, Sarvam for STT and TTS. Both the gateway (`src/voice/**`) and the app (`ios/**`) implement exactly this. Change it here first.

## Transport

`wss://bazaar.sciscribesolutions.com/voice` (local dev: `ws://127.0.0.1:8787/voice`).
Auth: HTTP header `Authorization: Bearer mtk_...` (member token) on the upgrade request. Missing/invalid → close 4401. One live voice session per member; a second connection closes the first with 4409.

Two frame kinds:
- **Binary frames, app → server:** raw mic audio, PCM signed 16-bit little-endian, 16 000 Hz, mono, 20–40 ms per frame (640–1280 bytes). Sent continuously while the session is open, including while Bazaar is speaking (needed for barge-in; the app uses `AVAudioSession` mode `.voiceChat` so echo cancellation removes Bazaar's own voice).
- **Binary frames, server → app:** TTS audio, MP3 bytes for the current `audio_start` segment, in order. The app feeds them to a streaming MP3 player.
- **Text frames, both ways:** one JSON object per frame, with a `type` field. Unknown types are ignored.

## App → server control messages

| type | fields | meaning |
| --- | --- | --- |
| `hello` | `appVersion`, `device`, `locale` (e.g. `bn-IN`), `placeHint?` (place key/nickname if the user picked one) | first message after connect |
| `interrupt` | — | user tapped to stop Bazaar talking (voice barge-in is detected server-side too) |
| `approve` | `quoteHash`, `biometric: true` | sent after a successful Face ID when the server asked for `needsBiometric` |
| `cancel` | — | user said/tapped "cancel" on the pending cart; server clears the pending confirmation |
| `bye` | — | user ended the session (or 20 s of silence on the app side) |

## Server → app messages

| type | fields | meaning |
| --- | --- | --- |
| `ready` | `sessionId`, `member` {name, role}, `place` {key, nickname} | gateway connected to STT; app shows "listening" |
| `state` | `value`: `listening` \| `thinking` \| `speaking` | drives the orb and haptics |
| `heard` | `text`, `lang` (e.g. `bn-IN`), `final: true` | caption of what the user said (final transcript per turn) |
| `say` | `turnId`, `text` | caption of what Bazaar is saying (sent before its audio) |
| `audio_start` | `turnId`, `segment` (int), `codec: "mp3"`, `sampleRate` | the following binary frames belong to this segment |
| `audio_end` | `turnId`, `segment` | segment complete |
| `stop_audio` | `turnId` | stop playback NOW and drop queued audio (barge-in, interrupt, or superseded) |
| `cart` | `quote` {hash, supplier, place, lines[{name,label,qty,lineTotal}], fees[{label,amount}], total, etaMinutes}, `removed[]` | show/refresh the cart card. Amounts are integer paise |
| `decision` | `verdict` PAY\|HOLD\|BLOCK, `reasons[]`, `quoteHash`, `needsBiometric` (bool), `spokenConfirmation` (bool) | gate result. `needsBiometric: true` → app runs Face ID then sends `approve` |
| `order` | `supplierOrderId`, `status`, `etaMinutes?` | order placed |
| `error` | `code`, `message` (user-safe) | recoverable error; session stays open |

## Voice approvals (enforced on the server, never on the app)

- A spoken "yes / haan / hyan, order it" approves the pending held quote only when ALL hold: the speaker is an `owner` authenticated by member token on this connection; Bazaar's previous turn spoke the total and asked for confirmation (state `awaiting_confirmation` for that exact quote hash); the quote total ≤ `VOICE_APPROVAL_MAX` (default ₹2,000); and less than 90 s have passed since the question.
- Above `VOICE_APPROVAL_MAX`, the server sends `decision` with `needsBiometric: true`; the app runs Face ID and sends `approve`. (The biometric is asserted by the owner's own authenticated device; the gate still re-reads the cart and checks the hash.)
- BLOCK verdicts are never approvable by voice or Face ID.
- Adders can build carts by voice; their "yes" is ignored for payment and Bazaar says the owner will approve.

## Speech behaviour

- Mirror the user's language mix. Bengali in Bengali script, Hindi in Devanagari, English words in Latin — Bulbul handles mixed scripts in one utterance. TTS `language_code` per turn = the dominant language STT reported for the user's last turn (bn-IN / hi-IN / en-IN).
- Short spoken sentences. Never read more than three items; summarise ("biryani-r sob jinish, curd ar ice cream").
- Speak money the way people say it ("এগারোশো তেইশ টাকা", "eleven twenty-three").
- When a tool call will take longer than ~1.2 s, play a short cached filler in the user's language ("ek second, dekhchi…").
- Never read ids, hashes, or addresses aloud; name the place by nickname.
