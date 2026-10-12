import Foundation

/// Money is integer paise everywhere. Never Double/Float.
enum Money {
    /// 112300 -> "₹1,123"; 112350 -> "₹1,123.50"; 123456700 -> "₹12,34,567".
    static func rupees(_ paise: Int) -> String {
        let negative = paise < 0
        let magnitude = paise.magnitude
        let whole = Int(magnitude / 100)
        let frac = Int(magnitude % 100)
        var text = "\u{20B9}" + groupIndian(whole)
        if frac != 0 {
            text += "." + (frac < 10 ? "0" : "") + String(frac)
        }
        return negative ? "-" + text : text
    }

    /// Indian digit grouping: last three digits, then groups of two.
    static func groupIndian(_ n: Int) -> String {
        let digits = Array(String(n))
        if digits.count <= 3 { return String(digits) }
        let lastThree = String(digits.suffix(3))
        var rest = Array(digits.dropLast(3))
        var parts: [String] = []
        while rest.count > 2 {
            parts.insert(String(rest.suffix(2)), at: 0)
            rest.removeLast(2)
        }
        if !rest.isEmpty {
            parts.insert(String(rest), at: 0)
        }
        parts.append(lastThree)
        return parts.joined(separator: ",")
    }
}
