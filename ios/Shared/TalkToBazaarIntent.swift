import AppIntents
import Foundation

// Compiled into BOTH the Bazaar app and the BazaarControls extension (see project.yml).
// With openAppWhenRun = true the system brings the app to the foreground and runs
// perform() in the app process. perform() only raises a flag; the app's UI layer
// consumes it and starts the voice session.

extension Notification.Name {
    static let bazaarTalkRequested = Notification.Name("com.sciscribe.bazaar.talkRequested")
}

enum TalkRequest {
    private static let key = "bazaar.pendingTalkAt"
    /// A request older than this is considered stale and ignored.
    private static let maxAge: TimeInterval = 30

    static func raise() {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: key)
        NotificationCenter.default.post(name: .bazaarTalkRequested, object: nil)
    }

    /// Returns true exactly once per raised request.
    static func consume() -> Bool {
        let defaults = UserDefaults.standard
        let stamp = defaults.double(forKey: key)
        guard stamp > 0 else { return false }
        defaults.removeObject(forKey: key)
        return Date().timeIntervalSince1970 - stamp <= maxAge
    }
}

struct TalkToBazaarIntent: AppIntent {
    static var title: LocalizedStringResource = "Talk to Bazaar"
    static var description = IntentDescription("Start a voice session with Bazaar.")
    static var openAppWhenRun: Bool = true

    init() {}

    func perform() async throws -> some IntentResult {
        TalkRequest.raise()
        return .result()
    }
}
