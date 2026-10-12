# Compile checklist: Apple APIs used

This code was written on Linux with no Swift compiler. Signatures below are what the code assumes (iOS 18 SDK, Swift 5.10 language mode). Items marked RISK are the ones most likely to need a tweak. Xcode 26 may add deprecation warnings (for example `.allowBluetooth` becoming `.allowBluetoothHFP`); those are warnings, not errors.

## Project / build

- XcodeGen keys: `info.properties` for Info.plist, `dependencies: - target: BazaarControls, embed: true`, `type: app-extension`. If `xcodegen generate` complains about a key, check the XcodeGen docs for your installed version.
- `Shared/TalkToBazaarIntent.swift` is in both targets (app: whole `Shared` folder; extension: that single file).
- The AppShortcutsProvider (`BazaarShortcuts.swift`) is app-only. Intent metadata extraction may warn when the intent exists in two targets; it is expected.

## AppIntents (`Shared/TalkToBazaarIntent.swift`, `BazaarShortcuts.swift`, `BazaarControls/*`)

- `protocol AppIntent { static var title: LocalizedStringResource { get }; static var description: IntentDescription { get }; static var openAppWhenRun: Bool { get }; func perform() async throws -> some IntentResult }`. Code: `static var title: LocalizedStringResource = "..."`, `static var description = IntentDescription("...")`, `static var openAppWhenRun: Bool = true`.
- `IntentDescription(_ descriptionText: LocalizedStringResource, ...)`.
- `protocol AppShortcutsProvider { @AppShortcutsBuilder static var appShortcuts: [AppShortcut] { get } }`.
- `AppShortcut(intent: some AppIntent, phrases: [AppShortcutPhrase<Intent>], shortTitle: LocalizedStringResource, systemImageName: String)`. Phrases are string literals with `\(.applicationName)`; every phrase must include it.
- WidgetKit controls: `struct TalkControl: ControlWidget { var body: some ControlWidgetConfiguration }`; `StaticControlConfiguration(kind: String, content: () -> some ControlWidgetTemplate)`; `ControlWidgetButton(action: some AppIntent, label: () -> some View)`; modifiers `.displayName(_: LocalizedStringResource)`, `.description(_: LocalizedStringResource)`. `@main struct ...: WidgetBundle { var body: some Widget }` (a `ControlWidget` is accepted as `Widget` in a bundle).
- RISK (behavior, not compile): whether an `openAppWhenRun` intent triggered from a Control runs `perform()` inside the app process. The app reads the flag from `UserDefaults.standard`. If a Control opens the app but no session starts, move the flag to an App Group: add the `App Groups` capability (`group.com.sciscribe.bazaar`) to both targets and use `UserDefaults(suiteName:)` in `TalkRequest`. The Action Button / Shortcut path is unaffected.

## SwiftUI

- `@main @MainActor struct BazaarApp: App`; `StateObject(wrappedValue:)` assigned to `_settings`/`_session` in `init()`.
- `View.onChange(of: V, initial: Bool = false, _ action: (V, V) -> Void)` (iOS 17 two-argument form) in `RootView`.
- `View.onOpenURL(perform: (URL) -> Void)`; `View.onReceive(_ publisher, perform:)` with `NotificationCenter.Publisher.receive(on:)` (needs `import Combine`).
- `View.task(priority:_: @Sendable () async -> Void)`; the polling loop is in a View method to stay main-actor isolated.
- `TimelineView(.animation(minimumInterval: Double?, paused: Bool)) { context in ... }`; `context.date`.
- `@ScaledMetric(relativeTo: Font.TextStyle) var x: CGFloat = 200`; `@Environment(\.accessibilityReduceMotion)`; `@Environment(\.scenePhase)`; `@Environment(\.dismiss)`.
- `RadialGradient(colors:center:startRadius:endRadius:)`, `AngularGradient(colors:center:)`, `Circle().strokeBorder(_ content: ShapeStyle, lineWidth:)` (AngularGradient is a ShapeStyle).
- `PasteButton(payloadType: String.self, onPaste: ([String]) -> Void)` (iOS 16).
- `View.textInputAutocapitalization(.never)`, `.autocorrectionDisabled()`, `.keyboardType(.URL)`, `.textContentType(.URL)`, `ToolbarItem(placement: .topBarTrailing)`.
- `.alert(_ title: String, isPresented: Binding<Bool>, actions: () -> A, message: () -> M)`.
- `.background(.regularMaterial, in: RoundedRectangle(cornerRadius:style:))`; `.transition(.move(edge:).combined(with:))`; `.animation(_: Animation?, value:)`.
- `Button(role: .cancel, action: ..., label: ...)`; `Label(_:systemImage:)`; `Font.monospacedDigit()`.

## AVFoundation / AVFAudio

- `AVAudioSession.sharedInstance().setCategory(_ category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions = []) throws` with `.playAndRecord`, `.voiceChat`, `[.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]`. (In the iOS 26 SDK `.allowBluetooth` is deprecated in favor of `.allowBluetoothHFP`.)
- `setActive(_ active: Bool) throws`; `setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws` with `.notifyOthersOnDeactivation`.
- `AVAudioApplication.shared.recordPermission` returning `AVAudioApplication.recordPermission` enum (`.undetermined/.denied/.granted`); `AVAudioApplication.requestRecordPermission(completionHandler: @escaping (Bool) -> Void)` (class method, iOS 17).
- Notifications: `AVAudioSession.interruptionNotification`, keys `AVAudioSessionInterruptionTypeKey` / `AVAudioSessionInterruptionOptionKey` (UInt), `AVAudioSession.InterruptionType(rawValue: UInt)`, `AVAudioSession.InterruptionOptions(rawValue:)`, `.shouldResume`; `AVAudioSession.routeChangeNotification`, `AVAudioSessionRouteChangeReasonKey`, `AVAudioSession.RouteChangeReason(rawValue: UInt)` with `.newDeviceAvailable`, `.oldDeviceUnavailable`; `Notification.Name.AVAudioEngineConfigurationChange`.
- `AVAudioEngine.inputNode`, `inputNode.outputFormat(forBus:)`, `installTap(onBus:bufferSize:format:block: AVAudioNodeTapBlock)` where the block is `(AVAudioPCMBuffer, AVAudioTime) -> Void`, `removeTap(onBus:)`, `engine.prepare()`, `try engine.start()`, `engine.stop()`.
- RISK: `AVAudioIONode.setVoiceProcessingEnabled(_ enabled: Bool) throws` and `isVoiceProcessingEnabled` (iOS 13). Enabled on the input node before start; on failure `MicCapture.start()` retries without it. Behavior risk: AEC reference signal when playback goes through AudioQueue instead of the same engine.
- `AVAudioFormat(commonFormat: .pcmFormatFloat32 / .pcmFormatInt16, sampleRate: Double, channels: AVAudioChannelCount, interleaved: Bool)` (failable).
- `AVAudioConverter(from: AVAudioFormat, to: AVAudioFormat)` (failable); `convert(to: AVAudioPCMBuffer, error: NSErrorPointer, withInputFrom: AVAudioConverterInputBlock) -> AVAudioConverterOutputStatus`; the block is `(AVAudioPacketCount, UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer?`; statuses `.haveData`, `.noDataNow`, `.error`.
- `AVAudioPCMBuffer(pcmFormat:frameCapacity:)` (failable), `frameLength`, `floatChannelData: UnsafePointer<UnsafeMutablePointer<Float>>?`, `int16ChannelData: UnsafePointer<UnsafeMutablePointer<Int16>>?`.
- `Data.append<S>(_ buffer: UnsafeBufferPointer<S>)` used with `UnsafeBufferPointer(start: channel[0], count:)`.

## AudioToolbox

- `AudioFileStreamOpen(_ inClientData: UnsafeMutableRawPointer?, _ inPropertyListenerProc: AudioFileStream_PropertyListenerProc, _ inPacketsProc: AudioFileStream_PacketsProc, _ inFileTypeHint: AudioFileTypeID, _ outAudioFileStream: UnsafeMutablePointer<AudioFileStreamID?>) -> OSStatus`. RISK: the two closure literals are passed inline with inferred parameter types, so they must not capture; the packets closure's last parameter is `UnsafeMutablePointer<AudioStreamPacketDescription>` (non-optional in some SDKs, optional in others); `handlePackets` takes an optional so either works.
- `AudioFileStream_PropertyListenerProc = (UnsafeMutableRawPointer, AudioFileStreamID, AudioFileStreamPropertyID, UnsafeMutablePointer<AudioFileStreamPropertyFlags>) -> Void`.
- `AudioFileStream_PacketsProc = (UnsafeMutableRawPointer, UInt32, UInt32, UnsafeRawPointer, UnsafeMutablePointer<AudioStreamPacketDescription>) -> Void`.
- `AudioFileStreamParseBytes(_ inAudioFileStream: AudioFileStreamID, _ inDataByteSize: UInt32, _ inData: UnsafeRawPointer?, _ inFlags: AudioFileStreamParseFlags) -> OSStatus` called with `[]`.
- `AudioFileStreamGetProperty(_ inAudioFileStream: AudioFileStreamID, _ inPropertyID: AudioFileStreamPropertyID, _ ioPropertyDataSize: UnsafeMutablePointer<UInt32>, _ outPropertyData: UnsafeMutableRawPointer) -> OSStatus`; `kAudioFileStreamProperty_DataFormat`; `AudioFileStreamClose(_:) -> OSStatus`; `kAudioFileMP3Type`.
- `AudioStreamPacketDescription(mStartOffset: Int64, mVariableFramesInPacket: UInt32, mDataByteSize: UInt32)`.
- `AudioQueueNewOutput(_ inFormat: UnsafePointer<AudioStreamBasicDescription>, _ inCallbackProc: AudioQueueOutputCallback, _ inUserData: UnsafeMutableRawPointer?, _ inCallbackRunLoop: CFRunLoop?, _ inCallbackRunLoopMode: CFString?, _ inFlags: UInt32, _ outAQ: UnsafeMutablePointer<AudioQueueRef?>) -> OSStatus`.
- `AudioQueueOutputCallback = @convention(c) (UnsafeMutableRawPointer?, AudioQueueRef, AudioQueueBufferRef) -> Void`, stored in a `private static let` closure with no captures.
- `AudioQueueAllocateBufferWithPacketDescriptions(_ inAQ: AudioQueueRef, _ inBufferByteSize: UInt32, _ inNumberPacketDescriptions: UInt32, _ outBuffer: UnsafeMutablePointer<AudioQueueBufferRef?>) -> OSStatus`.
- `AudioQueueEnqueueBuffer(_ inAQ: AudioQueueRef, _ inBuffer: AudioQueueBufferRef, _ inNumPacketDescs: UInt32, _ inPacketDescs: UnsafePointer<AudioStreamPacketDescription>?) -> OSStatus`.
- `AudioQueueStart(_ inAQ: AudioQueueRef, _ inStartTime: UnsafePointer<AudioTimeStamp>?) -> OSStatus`; `AudioQueueStop(_ inAQ: AudioQueueRef, _ inImmediate: Bool) -> OSStatus`; `AudioQueueDispose(_ inAQ: AudioQueueRef, _ inImmediate: Bool) -> OSStatus`; `AudioQueueFreeBuffer(_:_:) -> OSStatus`.
- `AudioQueueSetProperty(_ inAQ, _ inID: AudioQueuePropertyID, _ inData: UnsafeRawPointer, _ inDataSize: UInt32)` with `kAudioQueueProperty_EnableLevelMetering` (UInt32 = 1); `AudioQueueGetProperty(_ inAQ, _ inID, _ outData: UnsafeMutableRawPointer, _ ioDataSize: UnsafeMutablePointer<UInt32>)` with `kAudioQueueProperty_CurrentLevelMeter` into `[AudioQueueLevelMeterState]` (one element per channel; `mAveragePower`, `mPeakPower` are Float32, linear 0...1). RISK (behavior): metering on a compressed-input queue; if the speaking orb never reacts to level it falls back to its fixed pulse.

## LocalAuthentication

- `LAContext().canEvaluatePolicy(_ policy: LAPolicy, error: NSErrorPointer) -> Bool` with `&policyError` where `var policyError: NSError?`.
- `LAContext().evaluatePolicy(_ policy: LAPolicy, localizedReason: String) async throws -> Bool` (async overload of the completion-handler method). Policy `.deviceOwnerAuthenticationWithBiometrics` (no passcode fallback on purpose).

## Security (Keychain)

- `SecItemCopyMatching(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus`, `SecItemUpdate(_ query: CFDictionary, _ attributesToUpdate: CFDictionary) -> OSStatus`, `SecItemAdd(_ attributes: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus`, `SecItemDelete(_ query: CFDictionary) -> OSStatus`.
- Keys: `kSecClass`, `kSecClassGenericPassword`, `kSecAttrService`, `kSecAttrAccount`, `kSecValueData`, `kSecReturnData`, `kSecMatchLimit`, `kSecMatchLimitOne`, `kSecAttrAccessible`, `kSecAttrAccessibleAfterFirstUnlock`. Results compared to `errSecSuccess` / `errSecItemNotFound`.

## Foundation

- `URLSession(configuration:delegate:delegateQueue:)`, `URLSession.webSocketTask(with: URLRequest) -> URLSessionWebSocketTask`, `resume()`, `cancel(with: URLSessionWebSocketTask.CloseCode, reason: Data?)`, `send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping (Error?) -> Void)`, `receive(completionHandler: @escaping (Result<URLSessionWebSocketTask.Message, Error>) -> Void)`, `sendPing(pongReceiveHandler: @escaping (Error?) -> Void)`, `closeCode: URLSessionWebSocketTask.CloseCode` (`.rawValue: Int`, 0 = invalid), `invalidateAndCancel()`.
- Delegate methods: `urlSession(_:webSocketTask:didOpenWithProtocol:)`, `urlSession(_:webSocketTask:didCloseWith:reason:)`, `urlSession(_:task:didCompleteWithError:)`.
- RISK (behavior): custom close codes 4401/4409 must surface through `closeCode.rawValue`. If the server rejects the upgrade with HTTP 401 instead, `didCompleteWithError` maps `task.response` status 401 to 4401.
- `MainActor.assumeIsolated(_ operation: @MainActor () throws -> T) rethrows -> T` (Swift 5.9 stdlib, used to hop from `DispatchQueue.main` callbacks, notification observers on `.main`, and main-runloop Timers into the `@MainActor` VoiceSession without reordering messages).
- `Locale.current.language.languageCode?.identifier`, `Locale.current.region?.identifier` (iOS 16).
- `UIApplication.shared.isIdleTimerDisabled`, `UIDevice.current.model/systemVersion`, `UIImpactFeedbackGenerator(style:).impactOccurred()`, `UISelectionFeedbackGenerator().selectionChanged()`, `UINotificationFeedbackGenerator().notificationOccurred(_:)`.

## Likeliest first compile errors

1. `AudioFileStreamOpen` closure parameter types (see above).
2. `MainActor.assumeIsolated` closures returning `Void?` from `self?.method()` (fix: write `if let self { ... }` inside).
3. Non-Sendable capture warnings promoted by your build settings (project uses `SWIFT_STRICT_CONCURRENCY: minimal`).
4. XcodeGen `info.properties` formatting for `UILaunchScreen: {}`.
