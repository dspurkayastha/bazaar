# Bazaar for iPhone (voice terminal)

A thin native app. It captures the mic, plays Bazaar's voice, shows captions and the cart, and runs Face ID for large orders. All intelligence and every money rule lives on the server. The contract is `docs/VOICE_PROTOCOL.md`; the app side is implemented exactly as written there (`Bazaar/Protocol.swift`).

Requirements: Xcode 16 or newer, iOS 18.0+ device (the mic, Face ID and Action Button do not work properly in the Simulator), a Mac with Homebrew.

## Build and run

1. Install XcodeGen: `brew install xcodegen`
2. Set your signing team (once): open `ios/project.yml` and put your 10-character Team ID in `DEVELOPMENT_TEAM` (Xcode > Settings > Accounts > your team, or developer.apple.com > Membership). Skip this if you prefer to pick the team in Xcode in step 4.
3. Generate the project:
   ```
   cd ios
   xcodegen generate
   open Bazaar.xcodeproj
   ```
   `Bazaar.xcodeproj` and `ios/Support/` (Info.plists) are generated and git-ignored. Re-run `xcodegen generate` whenever `project.yml` or the file list changes.
4. In Xcode, select the **Bazaar** project, then for **both** targets (`Bazaar` and `BazaarControls`) open Signing & Capabilities and set the Team (only needed if you did not set `DEVELOPMENT_TEAM`; the choice is lost when you regenerate). A free Personal Team works, but the app expires after 7 days and must be reinstalled from Xcode. A paid Apple Developer account is needed for TestFlight.
5. Plug in the iPhone (trust the computer, enable Developer Mode under Settings > Privacy & Security if asked), choose it as the run destination, scheme **Bazaar**, press Run. On a free account, trust the developer under Settings > General > VPN & Device Management.
6. First launch: allow the microphone, then enter the Server URL (default `wss://bazaar.sciscribesolutions.com/voice`) and paste your member token (`mtk_...`).

Setup without typing: make a QR code (or a link) containing `bazaar://setup?url=<urlencoded wss url>&token=<token>` and open it with the iPhone Camera app or Notes. iOS hands it to Bazaar, which stores the URL in UserDefaults and the token in the Keychain. The in-app QR scanner was skipped on purpose. `bazaar://talk` starts a voice session.

## Action Button

Settings > Action Button > swipe to **Shortcut** > Choose a Shortcut > **Bazaar** > **Talk to Bazaar**.

Pressing the button opens Bazaar and starts listening immediately. Tap the orb to interrupt Bazaar, swipe down or tap X to end. The session also ends after 20 s with nothing heard and nothing spoken.

## Control Center / Lock Screen

Swipe down for Control Center, press + (or long-press empty space) > Add a Control > **Bazaar** > **Talk to Bazaar**. For the Lock Screen: customize the lock screen, tap a bottom control slot, pick the same control. The Control runs the same intent as the Action Button.

## Layout

```
ios/
  project.yml                 XcodeGen spec (targets, Info.plist keys, signing placeholder)
  Shared/TalkToBazaarIntent.swift     AppIntent; compiled into BOTH targets
  Bazaar/                     the app (protocol, session, audio, SwiftUI)
  BazaarControls/             iOS 18 ControlWidget extension
  CHECKLIST.md                every Apple API used, with signatures
```

## How a session works

`TalkToBazaarIntent` (openAppWhenRun) raises a flag and a notification. `RootView` consumes it and calls `VoiceSession.start()`: mic permission, `AVAudioSession` (`.playAndRecord`, `.voiceChat`, speaker + Bluetooth), mic engine to 16 kHz mono Int16 in 1280-byte frames, WebSocket with `Authorization: Bearer <token>`, `hello`, then everything on the protocol. Server MP3 between `audio_start` and `audio_end` is parsed with AudioFileStream and played by one AudioQueue; `stop_audio` disposes the queue immediately.

## Troubleshooting

**No microphone / "Microphone access is off".** Settings > Bazaar > Microphone on (or Settings > Privacy & Security > Microphone). If Bazaar is missing from that list the permission prompt never ran: delete and reinstall the app.

**"Token rejected" (close code 4401).** The server refused the member token (also raised if the upgrade returns HTTP 401). Open Settings in the app (it opens automatically), paste a fresh token, Save, tap the orb. Check the URL points at the right server (`/voice` path) and that the token is current on the server.

**"Another device took over" (4409).** Only one voice session per member. Another phone or a stale connection opened a session. Tap the orb to take it back.

**Connects but silence (orb listening, nothing happens).** Look at the server logs (gateway `src/voice/**` and the Sarvam STT/TTS calls) for the session id. Typical causes: STT not connected, wrong `locale`, TTS errors. In the app, an `error` message from the server shows as a red line under the orb. Also check the phone is not on silent-mode-only routing, the volume is up, and the mic is not claimed by a call.

**Bazaar hears its own voice / interrupts itself.** Echo cancellation depends on `.voiceChat` mode. In `Bazaar/MicCapture.swift` set `MicCapture.useVoiceProcessing = false` if engine-level voice processing misbehaves on your device, or the opposite if echo persists.

**Action Button starts the app but not the session.** Make sure the shortcut is Bazaar > Talk to Bazaar (not just "Open App"). If the Control Center control opens the app without starting a session, the intent ran in the extension process: see the note in `CHECKLIST.md` (App Group fallback).

**Build errors.** `ios/CHECKLIST.md` lists every Apple API used with its expected signature; this code was written without a Swift compiler, so fix the first errors there.
