import AVFoundation
import Foundation
import LocalAuthentication
import UIKit

enum AudioSessionManager {
    static func activate() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
        )
        try session.setActive(true)
    }

    static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

enum MicPermission {
    static func request() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        @unknown default:
            return false
        }
    }
}

enum BiometricResult {
    case approved
    case failed(String)
}

enum BiometricAuth {
    /// Face ID / Touch ID only (no passcode fallback): the protocol asserts `biometric: true`.
    static func authenticate(reason: String) async -> BiometricResult {
        let context = LAContext()
        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &policyError) else {
            return .failed(policyError?.localizedDescription ?? "Face ID is not available on this device")
        }
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                                                      localizedReason: reason)
            return ok ? .approved : .failed("Face ID did not match")
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}

@MainActor
enum Haptics {
    static func orbChanged(_ state: OrbState) {
        switch state {
        case .listening:
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        case .thinking:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .speaking:
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case .idle, .connecting:
            break
        }
    }

    static func cartShown() {
        UISelectionFeedbackGenerator().selectionChanged()
    }

    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    static func tap() {
        UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
    }
}

/// What the orb shows. Server `state` values map onto listening/thinking/speaking.
enum OrbState: Equatable {
    case idle
    case connecting
    case listening
    case thinking
    case speaking

    var label: String {
        switch self {
        case .idle: return "Tap to talk"
        case .connecting: return "Connecting"
        case .listening: return "Listening"
        case .thinking: return "Thinking"
        case .speaking: return "Speaking"
        }
    }
}

/// Live audio levels for the orb. Separate object so only the orb re-renders at 30 Hz.
@MainActor
final class AudioLevels: ObservableObject {
    @Published var mic: Float = 0
    @Published var out: Float = 0
}
