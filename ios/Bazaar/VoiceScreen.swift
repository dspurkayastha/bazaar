import SwiftUI

/// The single voice screen: orb, captions, cart card, order success.
struct VoiceScreen: View {
    @EnvironmentObject private var session: VoiceSession
    @Binding var showSettings: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            VStack(spacing: 20) {
                header
                Spacer(minLength: 0)
                Button(action: orbTapped) {
                    OrbView(state: session.orb, success: session.order != nil, levels: session.levels)
                }
                .buttonStyle(.plain)
                .accessibilityHint(session.isActive ? "Double tap to stop Bazaar talking" : "Double tap to start talking")
                statusLine
                captions
                Spacer(minLength: 0)
                bottomArea
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .gesture(
            DragGesture(minimumDistance: 40).onEnded { value in
                if value.translation.height > 120, abs(value.translation.width) < 120, session.isActive {
                    session.endByUser()
                }
            }
        )
        .animation(reduceMotion ? nil : .spring(response: 0.45, dampingFraction: 0.85),
                   value: session.cart?.hash)
    }

    private var header: some View {
        HStack {
            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.title3)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel("Settings")
            Spacer()
            if !session.placeNickname.isEmpty && session.isActive {
                Text(session.placeNickname)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                session.endByUser()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .symbolRenderingMode(.hierarchical)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel("End session")
            .opacity(session.isActive ? 1 : 0)
            .disabled(!session.isActive)
        }
    }

    @ViewBuilder
    private var statusLine: some View {
        if let order = session.order {
            VStack(spacing: 4) {
                Text("Order placed").font(.title2.weight(.semibold))
                if let eta = order.etaMinutes {
                    Text("Arriving in about \(eta) min").font(.title3).foregroundStyle(.secondary)
                }
            }
        } else if let notice = session.notice {
            Text(notice)
                .font(.callout)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
        } else if session.phase == .reconnecting {
            Text("Reconnecting").font(.callout).foregroundStyle(.secondary)
        } else if !session.isActive {
            VStack(spacing: 4) {
                Text(session.orb.label).font(.title3.weight(.medium))
                if let message = session.endReason?.message {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
        }
    }

    private var captions: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if !session.userCaption.isEmpty {
                    Text(session.userCaption)
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                if !session.bazaarCaption.isEmpty {
                    Text(session.bazaarCaption)
                        .font(.title2.weight(.semibold))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 200)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var bottomArea: some View {
        if let quote = session.cart, session.order == nil {
            ScrollView {
                CartCardView(
                    quote: quote,
                    removed: session.removedItems,
                    decision: session.decision,
                    approvalInFlight: session.approvalInFlight,
                    onApprove: { session.retryApproval() },
                    onCancel: { session.cancelCart() }
                )
            }
            .frame(maxHeight: 380)
            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        }
    }

    private func orbTapped() {
        if session.isActive {
            session.interrupt()
        } else {
            session.start()
        }
    }
}
