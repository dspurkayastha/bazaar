import SwiftUI

/// The central orb. Listening: breathes with mic level. Thinking: slow rotation.
/// Speaking: pulses with output level. Reduce Motion: static shape, color and label only.
struct OrbView: View {
    let state: OrbState
    let success: Bool
    @ObservedObject var levels: AudioLevels
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .largeTitle) private var scaledSize: CGFloat = 200
    private var size: CGFloat { min(scaledSize, 210) }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { context in
            orb(at: context.date.timeIntervalSinceReferenceDate)
        }
        .frame(width: size * 1.5, height: size * 1.5)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(success ? "Order placed" : state.label)
    }

    private var tint: Color {
        if success { return .green }
        switch state {
        case .idle: return .gray
        case .connecting: return .gray
        case .listening: return .teal
        case .thinking: return .indigo
        case .speaking: return .orange
        }
    }

    private func scale(at t: Double) -> CGFloat {
        if reduceMotion || success { return 1 }
        switch state {
        case .listening:
            return 1 + 0.03 * CGFloat(sin(t * 1.6)) + 0.30 * CGFloat(levels.mic)
        case .speaking:
            return 1 + 0.04 * CGFloat(sin(t * 3.0)) + 0.35 * CGFloat(levels.out)
        case .connecting:
            return 1 + 0.02 * CGFloat(sin(t * 2.0))
        case .thinking, .idle:
            return 1
        }
    }

    private func rotation(at t: Double) -> Double {
        if reduceMotion || state != .thinking { return 0 }
        return (t * 40).truncatingRemainder(dividingBy: 360)
    }

    private func orb(at t: Double) -> some View {
        let s = scale(at: t)
        return ZStack {
            Circle()
                .fill(tint.opacity(0.18))
                .frame(width: size * 1.4, height: size * 1.4)
                .scaleEffect(s * 1.04)
            Circle()
                .fill(RadialGradient(colors: [tint.opacity(0.95), tint.opacity(0.45)],
                                     center: .center, startRadius: 4, endRadius: size * 0.55))
                .frame(width: size, height: size)
                .scaleEffect(s)
                .shadow(color: tint.opacity(0.5), radius: 24)
            Circle()
                .strokeBorder(AngularGradient(colors: [tint, tint.opacity(0.0), tint],
                                              center: .center), lineWidth: 5)
                .frame(width: size * 1.12, height: size * 1.12)
                .rotationEffect(.degrees(rotation(at: t)))
                .opacity(state == .thinking ? 1 : 0.35)
            if success {
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.4, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
    }
}
