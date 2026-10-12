import SwiftUI

/// Slides up on `cart`: place nickname, up to 5 lines + "and N more", fees, total, ETA.
struct CartCardView: View {
    static let maxLines = 5

    let quote: Quote
    let removed: [String]
    let decision: DecisionMsg?
    let approvalInFlight: Bool
    let onApprove: () -> Void
    let onCancel: () -> Void

    private var placeTitle: String {
        return quote.place?.value ?? ""
    }

    private var shownLines: [QuoteLine] {
        return Array(quote.lines.prefix(CartCardView.maxLines))
    }

    private var hiddenCount: Int {
        return max(0, quote.lines.count - CartCardView.maxLines)
    }

    private var isBlocked: Bool {
        return decision?.verdict.uppercased() == "BLOCK"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(placeTitle.isEmpty ? "Your cart" : placeTitle)
                    .font(.headline)
                Spacer()
                if let eta = quote.etaMinutes {
                    Label("\(eta) min", systemImage: "clock")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(Array(shownLines.enumerated()), id: \.offset) { _, line in
                HStack(alignment: .firstTextBaseline) {
                    Text(lineTitle(line))
                        .font(.body)
                    Spacer(minLength: 8)
                    Text(Money.rupees(line.lineTotal))
                        .font(.body.monospacedDigit())
                }
            }
            if hiddenCount > 0 {
                Text("and \(hiddenCount) more")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if !removed.isEmpty {
                Text("Removed: " + removed.joined(separator: ", "))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if !quote.fees.isEmpty {
                Divider()
                ForEach(Array(quote.fees.enumerated()), id: \.offset) { _, fee in
                    HStack {
                        Text(fee.label)
                        Spacer()
                        Text(Money.rupees(fee.amount)).monospacedDigit()
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
            }
            Divider()
            HStack {
                Text("Total").font(.title3.weight(.semibold))
                Spacer()
                Text(Money.rupees(quote.total))
                    .font(.title3.weight(.semibold).monospacedDigit())
            }
            decisionFooter
            HStack {
                Button(role: .cancel, action: onCancel) {
                    Text("Cancel")
                }
                .buttonStyle(.bordered)
                Spacer()
                if needsBiometric {
                    Button(action: onApprove) {
                        Label("Approve with Face ID", systemImage: "faceid")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(approvalInFlight)
                }
            }
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private var needsBiometric: Bool {
        guard let d = decision else { return false }
        return d.needsBiometric == true && !isBlocked
    }

    @ViewBuilder
    private var decisionFooter: some View {
        if let d = decision {
            if isBlocked {
                Text(reasonText(d) ?? "This order cannot be placed.")
                    .font(.subheadline)
                    .foregroundStyle(.red)
            } else if d.needsBiometric == true {
                Text(approvalInFlight ? "Waiting for Face ID" : "Needs your approval")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if d.verdict.uppercased() == "HOLD" {
                Text(reasonText(d) ?? "On hold. Say yes to confirm.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func reasonText(_ d: DecisionMsg) -> String? {
        guard let reasons = d.reasons, !reasons.isEmpty else { return nil }
        return reasons.joined(separator: ". ")
    }

    private func lineTitle(_ line: QuoteLine) -> String {
        var text = line.name
        if let label = line.label, !label.isEmpty {
            text += " (" + label + ")"
        }
        if line.qty != 1 {
            text += " \u{00D7} \(line.qty)"
        }
        return text
    }
}
