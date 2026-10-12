import Combine
import SwiftUI

/// Chooses onboarding vs. the voice screen, and wires launch triggers:
/// the App Intent (Action Button / Control), the bazaar:// URL scheme, and scene activation.
struct RootView: View {
    @EnvironmentObject private var settings: SettingsStore
    @EnvironmentObject private var session: VoiceSession
    @Environment(\.scenePhase) private var scenePhase
    @State private var showSettings = false

    var body: some View {
        Group {
            if settings.isConfigured {
                VoiceScreen(showSettings: $showSettings)
            } else {
                NavigationStack {
                    SettingsView(isOnboarding: true)
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                SettingsView(isOnboarding: false)
            }
        }
        .alert("Bazaar", isPresented: setupAlertBinding) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(settings.setupMessage ?? "")
        }
        .onOpenURL { url in
            handle(url)
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                startIfRequested()
            }
        }
        .onChange(of: session.endReason) { _, reason in
            if reason == .tokenRejected {
                showSettings = true
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .bazaarTalkRequested)
            .receive(on: DispatchQueue.main)) { _ in
            startIfRequested()
        }
        .task {
            await pollLaunchRequest()
        }
    }

    /// Cold launch from the Action Button: the intent may raise its flag a moment
    /// after the first frame, so poll briefly.
    private func pollLaunchRequest() async {
        for _ in 0..<20 {
            startIfRequested()
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    private var setupAlertBinding: Binding<Bool> {
        Binding(
            get: { settings.setupMessage != nil },
            set: { if !$0 { settings.setupMessage = nil } }
        )
    }

    private func startIfRequested() {
        if TalkRequest.consume() {
            session.start()
        }
    }

    private func handle(_ url: URL) {
        guard url.scheme?.lowercased() == "bazaar" else { return }
        switch url.host?.lowercased() {
        case "setup":
            _ = settings.applySetup(from: url)
        case "talk":
            session.start()
        default:
            break
        }
    }
}
