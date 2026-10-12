import AVFoundation
import Foundation
import UIKit

enum EndReason: Equatable {
    case user
    case idle
    case tokenRejected
    case takenOver
    case serverClosed
    case connectionLost
    case micDenied
    case audioFailure
    case interrupted
    case notConfigured

    /// User-facing text; nil when nothing needs saying.
    var message: String? {
        switch self {
        case .user, .idle, .serverClosed: return nil
        case .tokenRejected: return "Token rejected. Paste a new member token in Settings."
        case .takenOver: return "Another device took over the voice session."
        case .connectionLost: return "Could not reach the server."
        case .micDenied: return "Microphone access is off. Enable it in Settings > Bazaar."
        case .audioFailure: return "Audio failed to start. Try again."
        case .interrupted: return "Call or alarm interrupted the session."
        case .notConfigured: return "Set the server URL and token first."
        }
    }
}

/// Owns the whole voice terminal: audio session, mic, websocket, playback, and UI-facing state.
/// All intelligence and every money rule lives on the server (docs/VOICE_PROTOCOL.md).
@MainActor
final class VoiceSession: ObservableObject {
    enum Phase: Equatable {
        case idle, connecting, live, reconnecting, ended
    }

    // MARK: UI state

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var orb: OrbState = .idle
    @Published private(set) var userCaption = ""
    @Published private(set) var bazaarCaption = ""
    @Published private(set) var cart: Quote?
    @Published private(set) var removedItems: [String] = []
    @Published private(set) var decision: DecisionMsg?
    @Published private(set) var order: OrderMsg?
    @Published private(set) var notice: String?
    @Published private(set) var endReason: EndReason?
    @Published private(set) var placeNickname = ""
    @Published private(set) var memberName = ""
    @Published private(set) var approvalInFlight = false
    let levels = AudioLevels()

    var isActive: Bool {
        return phase == .connecting || phase == .live || phase == .reconnecting
    }

    // MARK: Internals

    private static let idleTimeout: TimeInterval = 20
    private static let reconnectDelays: [Double] = [0.5, 1, 2, 4, 8, 15]

    private let settings: SettingsStore
    private let mic = MicCapture()
    private let player = MP3StreamPlayer()
    private let sink = FrameSink()
    private var connection: WebSocketConnection?
    private var wantLive = false
    private var attempt = 0
    private var interrupted = false
    private var micRestartScheduled = false
    private var segmentOpen = false
    private var lastActivity = Date()
    private var startTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var approvalTask: Task<Void, Never>?
    private var noticeTask: Task<Void, Never>?
    private var pingTimer: Timer?
    private var watchdogTimer: Timer?
    private var levelTimer: Timer?
    private var observers: [NSObjectProtocol] = []

    init(settings: SettingsStore) {
        self.settings = settings
        let sink = self.sink
        mic.onChunk = { data in
            sink.send(data)
        }
    }

    // MARK: Start / end

    func start() {
        guard phase == .idle || phase == .ended else { return }
        guard settings.isConfigured, settings.socketURL != nil else {
            phase = .ended
            endReason = .notConfigured
            return
        }
        resetUI()
        wantLive = true
        attempt = 0
        interrupted = false
        phase = .connecting
        orb = .connecting
        endReason = nil
        UIApplication.shared.isIdleTimerDisabled = true
        Haptics.tap()
        startTask = Task { [weak self] in
            guard let self = self else { return }
            let granted = await MicPermission.request()
            guard self.wantLive, !Task.isCancelled else { return }
            guard granted else {
                self.end(.micDenied, sendBye: false)
                return
            }
            do {
                try AudioSessionManager.activate()
                self.installObservers()
                try self.mic.start()
            } catch {
                self.end(.audioFailure, sendBye: false)
                return
            }
            self.startTimers()
            self.openConnection()
        }
    }

    /// User swipe-down / X button.
    func endByUser() {
        end(.user, sendBye: true)
    }

    private func end(_ reason: EndReason, sendBye: Bool) {
        guard phase != .ended else { return }
        wantLive = false
        startTask?.cancel()
        reconnectTask?.cancel()
        approvalTask?.cancel()
        stopTimers()
        removeObservers()
        sink.set(nil)
        if let c = connection {
            connection = nil
            if sendBye, let text = ProtocolCoder.encode(ByeMsg()) {
                c.sendText(text) { c.close() }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { c.close() }
            } else {
                c.close()
            }
        }
        mic.stop()
        player.stop()
        segmentOpen = false
        AudioSessionManager.deactivate()
        UIApplication.shared.isIdleTimerDisabled = false
        levels.mic = 0
        levels.out = 0
        approvalInFlight = false
        cart = nil
        decision = nil
        phase = .ended
        orb = .idle
        endReason = reason
    }

    private func resetUI() {
        userCaption = ""
        bazaarCaption = ""
        cart = nil
        removedItems = []
        decision = nil
        order = nil
        notice = nil
        approvalInFlight = false
        segmentOpen = false
    }

    // MARK: Connection

    private func openConnection() {
        guard wantLive, let url = settings.socketURL else { return }
        let c = WebSocketConnection(url: url, token: settings.token)
        c.onEvent = { [weak self, weak c] event in
            MainActor.assumeIsolated {
                guard let self = self, let c = c else { return }
                self.handle(event, from: c)
            }
        }
        connection = c
        c.connect()
    }

    private func handle(_ event: WSEvent, from source: WebSocketConnection) {
        guard source === connection else { return }
        switch event {
        case .open:
            attempt = 0
            phase = .live
            touch()
            sink.set(source)
            sendHello(on: source)
        case .text(let text):
            if let message = ServerMessage.parse(text) {
                handle(message)
            }
        case .binary(let data):
            guard segmentOpen else { return }
            touch()
            player.append(data)
        case .closed(let code, _):
            sink.set(nil)
            connection = nil
            handleClosed(code: code)
        }
    }

    private func sendHello(on c: WebSocketConnection) {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let device = UIDevice.current.model + " iOS " + UIDevice.current.systemVersion
        let hint = settings.placeHint
        let hello = HelloMsg(appVersion: version,
                             device: device,
                             locale: settings.locale,
                             placeHint: hint.isEmpty ? nil : hint)
        if let text = ProtocolCoder.encode(hello) {
            c.sendText(text)
        }
    }

    private func handleClosed(code: Int) {
        guard wantLive else { return }
        switch code {
        case 4401:
            end(.tokenRejected, sendBye: false)
        case 4409:
            end(.takenOver, sendBye: false)
        case 1000:
            end(.serverClosed, sendBye: false)
        default:
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        let delays = VoiceSession.reconnectDelays
        guard attempt < delays.count else {
            end(.connectionLost, sendBye: false)
            return
        }
        let delay = delays[attempt]
        attempt += 1
        phase = .reconnecting
        orb = .connecting
        player.stop()
        segmentOpen = false
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self = self, self.wantLive, !Task.isCancelled else { return }
            self.openConnection()
        }
    }

    private func send<T: Encodable>(_ message: T) {
        guard let c = connection, let text = ProtocolCoder.encode(message) else { return }
        c.sendText(text)
    }

    // MARK: Server messages

    private func handle(_ message: ServerMessage) {
        switch message {
        case .ready(let m):
            placeNickname = m.place?.nickname ?? m.place?.key ?? ""
            memberName = m.member?.name ?? ""
            touch()
            setOrb(.listening)
        case .state(let m):
            switch m.value {
            case "listening": setOrb(.listening)
            case "thinking": setOrb(.thinking); touch()
            case "speaking": setOrb(.speaking); touch()
            default: break
            }
        case .heard(let m):
            userCaption = m.text
            touch()
        case .say(let m):
            bazaarCaption = m.text
            touch()
        case .audioStart(let m):
            guard (m.codec ?? "mp3") == "mp3" else { return }
            segmentOpen = true
            player.beginSegment()
            touch()
        case .audioEnd:
            guard segmentOpen else { return }
            segmentOpen = false
            player.endSegment()
        case .stopAudio:
            segmentOpen = false
            player.stop()
        case .cart(let m):
            cart = m.quote
            removedItems = (m.removed ?? []).map { $0.value }.filter { !$0.isEmpty }
            decision = nil
            order = nil
            approvalInFlight = false
            touch()
            Haptics.cartShown()
        case .decision(let m):
            decision = m
            touch()
            if m.verdict.uppercased() == "BLOCK" {
                Haptics.warning()
            } else if m.needsBiometric == true {
                runApproval(for: m)
            }
        case .order(let m):
            order = m
            approvalInFlight = false
            touch()
            Haptics.success()
        case .error(let m):
            showNotice(m.message ?? "Something went wrong.")
        case .unknown:
            break
        }
    }

    private func setOrb(_ state: OrbState) {
        if orb != state {
            orb = state
            Haptics.orbChanged(state)
        }
    }

    private func showNotice(_ text: String) {
        notice = text
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    // MARK: User actions

    /// Tap on the orb while a session is live.
    func interrupt() {
        guard isActive else { return }
        player.stop()
        segmentOpen = false
        send(InterruptMsg())
        Haptics.tap()
        touch()
    }

    func cancelCart() {
        send(CancelMsg())
        cart = nil
        decision = nil
        approvalInFlight = false
        touch()
    }

    /// Runs Face ID for the pending decision and sends `approve` on success.
    func retryApproval() {
        if let d = decision, d.needsBiometric == true, d.verdict.uppercased() != "BLOCK" {
            runApproval(for: d)
        }
    }

    private func runApproval(for d: DecisionMsg) {
        guard !approvalInFlight, let hash = d.quoteHash else { return }
        var reason = "Approve order"
        if let quote = cart, quote.hash == hash {
            reason = "Approve " + Money.rupees(quote.total)
            let placeName = quote.place?.value ?? placeNickname
            if !placeName.isEmpty { reason += " at " + placeName }
        }
        approvalInFlight = true
        touch()
        approvalTask?.cancel()
        approvalTask = Task { [weak self] in
            let result = await BiometricAuth.authenticate(reason: reason)
            guard let self = self, !Task.isCancelled, self.isActive else { return }
            switch result {
            case .approved:
                self.send(ApproveMsg(quoteHash: hash))
                self.touch()
                // approvalInFlight stays true until `order` or a new `cart` arrives.
            case .failed(let text):
                self.approvalInFlight = false
                self.showNotice(text)
            }
        }
    }

    // MARK: Idle watchdog, ping, levels

    private func touch() {
        lastActivity = Date()
    }

    private func startTimers() {
        stopTimers()
        lastActivity = Date()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pingTick() }
        }
        watchdogTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.watchdogTick() }
        }
        levelTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.levelTick() }
        }
    }

    private func stopTimers() {
        pingTimer?.invalidate()
        watchdogTimer?.invalidate()
        levelTimer?.invalidate()
        pingTimer = nil
        watchdogTimer = nil
        levelTimer = nil
    }

    private func pingTick() {
        guard phase == .live, let c = connection else { return }
        c.sendPing { ok in
            if !ok {
                c.abort()
            }
        }
    }

    private func watchdogTick() {
        guard phase == .live else { return }
        if player.isBusy() {
            touch()
            return
        }
        if Date().timeIntervalSince(lastActivity) > VoiceSession.idleTimeout {
            end(.idle, sendBye: true)
        }
    }

    private func levelTick() {
        let micLevel = mic.level
        let outLevel = player.currentLevel()
        levels.mic = levels.mic * 0.6 + micLevel * 0.4
        levels.out = levels.out * 0.6 + outLevel * 0.4
    }

    // MARK: Audio interruptions and route changes

    private func installObservers() {
        removeObservers()
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification,
                                            object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated { self?.handleInterruption(note) }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification,
                                            object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated { self?.handleRouteChange(note) }
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange,
                                            object: mic.engine, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleMicRestart() }
        })
    }

    private func removeObservers() {
        for token in observers {
            NotificationCenter.default.removeObserver(token)
        }
        observers.removeAll()
    }

    private func handleInterruption(_ note: Notification) {
        guard wantLive,
              let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            interrupted = true
            mic.stop()
            player.stop()
            segmentOpen = false
        case .ended:
            interrupted = false
            var shouldResume = false
            if let optRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt {
                shouldResume = AVAudioSession.InterruptionOptions(rawValue: optRaw).contains(.shouldResume)
            }
            if shouldResume {
                do {
                    try AudioSessionManager.activate()
                    try mic.start()
                } catch {
                    end(.audioFailure, sendBye: true)
                }
            } else {
                end(.interrupted, sendBye: true)
            }
        @unknown default:
            break
        }
    }

    private func handleRouteChange(_ note: Notification) {
        guard wantLive,
              let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        switch reason {
        case .newDeviceAvailable, .oldDeviceUnavailable:
            scheduleMicRestart()
        default:
            break
        }
    }

    /// Debounced: a single route change usually produces several notifications.
    private func scheduleMicRestart() {
        guard wantLive, !interrupted, !micRestartScheduled else { return }
        micRestartScheduled = true
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard let self = self else { return }
            self.micRestartScheduled = false
            guard self.wantLive, !self.interrupted else { return }
            self.mic.stop()
            do {
                try self.mic.start()
            } catch {
                self.end(.audioFailure, sendBye: true)
            }
        }
    }
}
