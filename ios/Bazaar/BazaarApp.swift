import SwiftUI

@main
@MainActor
struct BazaarApp: App {
    @StateObject private var settings: SettingsStore
    @StateObject private var session: VoiceSession

    init() {
        let store = SettingsStore()
        _settings = StateObject(wrappedValue: store)
        _session = StateObject(wrappedValue: VoiceSession(settings: store))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(settings)
                .environmentObject(session)
        }
    }
}
