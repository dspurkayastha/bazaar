import SwiftUI

/// Used both as first-launch onboarding and as the Settings sheet.
struct SettingsView: View {
    let isOnboarding: Bool

    @EnvironmentObject private var settings: SettingsStore
    @EnvironmentObject private var session: VoiceSession
    @Environment(\.dismiss) private var dismiss

    @State private var url = ""
    @State private var token = ""
    @State private var locale = "en-IN"
    @State private var placeHint = ""
    @State private var errorText: String?
    @State private var loaded = false

    var body: some View {
        Form {
            if isOnboarding {
                Section {
                    Text("Enter your Bazaar server and member token. You can also scan the setup QR code with the Camera app.")
                        .font(.callout)
                }
            }
            if session.endReason == .tokenRejected {
                Section {
                    Text("Token rejected by the server. Paste a new member token.")
                        .foregroundStyle(.red)
                }
            }
            Section("Server URL") {
                TextField("wss://bazaar.example.com/voice", text: $url)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Section("Member token") {
                SecureField("mtk_...", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                PasteButton(payloadType: String.self) { strings in
                    if let first = strings.first {
                        token = first.trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                }
            }
            Section("Speech") {
                Picker("Language hint", selection: $locale) {
                    ForEach(localeOptions, id: \.self) { code in
                        Text(code).tag(code)
                    }
                }
                TextField("Place nickname (optional)", text: $placeHint)
                    .autocorrectionDisabled()
            }
            if let errorText = errorText {
                Section {
                    Text(errorText).foregroundStyle(.red)
                }
            }
            Section {
                Button(isOnboarding ? "Get started" : "Save") {
                    save()
                }
                .disabled(url.isEmpty || token.isEmpty)
            }
            if !isOnboarding {
                Section {
                    Button("Remove token", role: .destructive) {
                        settings.clearToken()
                        dismiss()
                    }
                }
            }
        }
        .navigationTitle(isOnboarding ? "Welcome to Bazaar" : "Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !isOnboarding {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            url = settings.serverURL
            token = settings.token
            locale = settings.locale
            placeHint = settings.placeHint
        }
    }

    private var localeOptions: [String] {
        var options = SettingsStore.localeChoices
        if !options.contains(locale) {
            options.append(locale)
        }
        return options
    }

    private func save() {
        if let message = settings.save(url: url, token: token, locale: locale, placeHint: placeHint) {
            errorText = message
        } else {
            errorText = nil
            if !isOnboarding {
                dismiss()
            }
        }
    }
}
