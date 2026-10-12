import AppIntents

/// Makes "Talk to Bazaar" show up in the Shortcuts app and the Action Button picker
/// (Settings > Action Button > Shortcut > Bazaar > Talk to Bazaar).
struct BazaarShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TalkToBazaarIntent(),
            phrases: [
                "Talk to \(.applicationName)",
                "Start \(.applicationName)"
            ],
            shortTitle: "Talk to Bazaar",
            systemImageName: "waveform"
        )
    }
}
