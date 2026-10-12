import Foundation

/// Server URL + preferences live in UserDefaults; the member token lives in the Keychain.
@MainActor
final class SettingsStore: ObservableObject {
    static let defaultServerURL = "wss://bazaar.sciscribesolutions.com/voice"
    static let localeChoices = ["bn-IN", "hi-IN", "en-IN"]

    private enum Keys {
        static let url = "bazaar.serverURL"
        static let locale = "bazaar.locale"
        static let placeHint = "bazaar.placeHint"
        static let tokenAccount = "memberToken"
    }

    @Published private(set) var serverURL: String
    @Published private(set) var token: String
    @Published private(set) var locale: String
    @Published private(set) var placeHint: String
    /// One-shot message shown after a bazaar://setup link was applied (or rejected).
    @Published var setupMessage: String?

    init() {
        let defaults = UserDefaults.standard
        serverURL = defaults.string(forKey: Keys.url) ?? SettingsStore.defaultServerURL
        token = Keychain.read(account: Keys.tokenAccount) ?? ""
        locale = defaults.string(forKey: Keys.locale) ?? SettingsStore.deviceLocale()
        placeHint = defaults.string(forKey: Keys.placeHint) ?? ""
    }

    /// Device language + region as a BCP-47 tag such as "en-IN".
    static func deviceLocale() -> String {
        let lang = Locale.current.language.languageCode?.identifier ?? "en"
        let region = Locale.current.region?.identifier ?? "IN"
        return lang + "-" + region
    }

    var socketURL: URL? {
        return SettingsStore.validatedURL(serverURL)
    }

    var isConfigured: Bool {
        return !token.isEmpty && socketURL != nil
    }

    static func validatedURL(_ text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              let host = url.host, !host.isEmpty else { return nil }
        return url
    }

    /// Returns an error message, or nil on success.
    @discardableResult
    func save(url: String, token newToken: String, locale newLocale: String, placeHint newHint: String) -> String? {
        let cleanURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanToken = newToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard SettingsStore.validatedURL(cleanURL) != nil else {
            return "Server URL must start with wss:// or ws://"
        }
        guard !cleanToken.isEmpty else {
            return "Member token is empty"
        }
        guard Keychain.write(cleanToken, account: Keys.tokenAccount) else {
            return "Could not store the token in the Keychain"
        }
        let defaults = UserDefaults.standard
        defaults.set(cleanURL, forKey: Keys.url)
        defaults.set(newLocale, forKey: Keys.locale)
        defaults.set(newHint.trimmingCharacters(in: .whitespacesAndNewlines), forKey: Keys.placeHint)
        serverURL = cleanURL
        token = cleanToken
        locale = newLocale
        placeHint = newHint.trimmingCharacters(in: .whitespacesAndNewlines)
        return nil
    }

    /// Handles bazaar://setup?url=...&token=... . Returns true if it was a setup link and was applied.
    func applySetup(from link: URL) -> Bool {
        guard link.scheme?.lowercased() == "bazaar", link.host?.lowercased() == "setup",
              let comps = URLComponents(url: link, resolvingAgainstBaseURL: false) else { return false }
        let items = comps.queryItems ?? []
        let urlValue = items.first(where: { $0.name == "url" })?.value ?? serverURL
        let tokenValue = items.first(where: { $0.name == "token" })?.value ?? ""
        if let error = save(url: urlValue, token: tokenValue, locale: locale, placeHint: placeHint) {
            setupMessage = "Setup link rejected: " + error
            return false
        }
        setupMessage = "Setup applied. You are ready to talk."
        return true
    }

    func clearToken() {
        Keychain.delete(account: Keys.tokenAccount)
        token = ""
    }
}
