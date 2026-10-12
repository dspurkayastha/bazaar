import Foundation

// Mirrors docs/VOICE_PROTOCOL.md exactly. Change the doc first, then this file.
// Field names are camelCase as in the doc; `type` values are snake_case strings.
// Amounts are integer paise.

// MARK: - Lenient helpers (the doc does not pin these shapes down)

/// Decodes a JSON string, number, or object (nickname/name/label/key/id) into a String.
/// Used where VOICE_PROTOCOL.md is ambiguous: turnId, quote.supplier, quote.place, removed[].
struct FlexString: Decodable, Equatable {
    let value: String

    init(_ value: String) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer() {
            if let s = try? single.decode(String.self) {
                value = s
                return
            }
            if let i = try? single.decode(Int.self) {
                value = String(i)
                return
            }
        }
        if let keyed = try? decoder.container(keyedBy: AnyCodingKey.self) {
            for name in ["nickname", "name", "label", "key", "id"] {
                if let key = AnyCodingKey(stringValue: name),
                   let s = try? keyed.decode(String.self, forKey: key) {
                    value = s
                    return
                }
            }
        }
        value = ""
    }
}

struct AnyCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}

// MARK: - App -> server

struct HelloMsg: Encodable {
    let type = "hello"
    let appVersion: String
    let device: String
    let locale: String
    let placeHint: String?
}

struct InterruptMsg: Encodable {
    let type = "interrupt"
}

struct ApproveMsg: Encodable {
    let type = "approve"
    let quoteHash: String
    let biometric = true
}

struct CancelMsg: Encodable {
    let type = "cancel"
}

struct ByeMsg: Encodable {
    let type = "bye"
}

enum ProtocolCoder {
    static func encode<T: Encodable>(_ value: T) -> String? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

// MARK: - Server -> app

struct MemberInfo: Decodable {
    let name: String?
    let role: String?
}

struct PlaceInfo: Decodable {
    let key: String?
    let nickname: String?
}

struct ReadyMsg: Decodable {
    let sessionId: String?
    let member: MemberInfo?
    let place: PlaceInfo?
}

struct StateMsg: Decodable {
    let value: String   // listening | thinking | speaking
}

struct HeardMsg: Decodable {
    let text: String
    let lang: String?
    let isFinal: Bool?

    enum CodingKeys: String, CodingKey {
        case text, lang
        case isFinal = "final"
    }
}

struct SayMsg: Decodable {
    let turnId: FlexString?
    let text: String
}

struct AudioStartMsg: Decodable {
    let turnId: FlexString?
    let segment: Int?
    let codec: String?
    let sampleRate: Int?
}

struct AudioEndMsg: Decodable {
    let turnId: FlexString?
    let segment: Int?
}

struct StopAudioMsg: Decodable {
    let turnId: FlexString?
}

struct QuoteLine: Decodable {
    let name: String
    let label: String?
    let qty: Int
    let lineTotal: Int   // paise
}

struct QuoteFee: Decodable {
    let label: String
    let amount: Int      // paise
}

struct Quote: Decodable {
    let hash: String
    let supplier: FlexString?
    let place: FlexString?
    let lines: [QuoteLine]
    let fees: [QuoteFee]
    let total: Int       // paise
    let etaMinutes: Int?

    enum CodingKeys: String, CodingKey {
        case hash, supplier, place, lines, fees, total, etaMinutes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hash = try c.decode(String.self, forKey: .hash)
        supplier = try c.decodeIfPresent(FlexString.self, forKey: .supplier)
        place = try c.decodeIfPresent(FlexString.self, forKey: .place)
        lines = try c.decodeIfPresent([QuoteLine].self, forKey: .lines) ?? []
        fees = try c.decodeIfPresent([QuoteFee].self, forKey: .fees) ?? []
        total = try c.decode(Int.self, forKey: .total)
        etaMinutes = try c.decodeIfPresent(Int.self, forKey: .etaMinutes)
    }
}

struct CartMsg: Decodable {
    let quote: Quote
    let removed: [FlexString]?
}

struct DecisionMsg: Decodable {
    let verdict: String          // PAY | HOLD | BLOCK
    let reasons: [String]?
    let quoteHash: String?
    let needsBiometric: Bool?
    let spokenConfirmation: Bool?
}

struct OrderMsg: Decodable {
    let supplierOrderId: FlexString?
    let status: String?
    let etaMinutes: Int?
}

struct ErrorMsg: Decodable {
    let code: String?
    let message: String?
}

enum ServerMessage {
    case ready(ReadyMsg)
    case state(StateMsg)
    case heard(HeardMsg)
    case say(SayMsg)
    case audioStart(AudioStartMsg)
    case audioEnd(AudioEndMsg)
    case stopAudio(StopAudioMsg)
    case cart(CartMsg)
    case decision(DecisionMsg)
    case order(OrderMsg)
    case error(ErrorMsg)
    case unknown(String)

    private struct Envelope: Decodable {
        let type: String
    }

    /// Returns nil for malformed JSON or a known type whose body fails to decode.
    /// Unknown `type` values return `.unknown` (the protocol says to ignore them).
    static func parse(_ text: String) -> ServerMessage? {
        let data = Data(text.utf8)
        let decoder = JSONDecoder()
        guard let env = try? decoder.decode(Envelope.self, from: data) else { return nil }
        switch env.type {
        case "ready":
            return (try? decoder.decode(ReadyMsg.self, from: data)).map { .ready($0) }
        case "state":
            return (try? decoder.decode(StateMsg.self, from: data)).map { .state($0) }
        case "heard":
            return (try? decoder.decode(HeardMsg.self, from: data)).map { .heard($0) }
        case "say":
            return (try? decoder.decode(SayMsg.self, from: data)).map { .say($0) }
        case "audio_start":
            return (try? decoder.decode(AudioStartMsg.self, from: data)).map { .audioStart($0) }
        case "audio_end":
            return (try? decoder.decode(AudioEndMsg.self, from: data)).map { .audioEnd($0) }
        case "stop_audio":
            return (try? decoder.decode(StopAudioMsg.self, from: data)).map { .stopAudio($0) }
        case "cart":
            return (try? decoder.decode(CartMsg.self, from: data)).map { .cart($0) }
        case "decision":
            return (try? decoder.decode(DecisionMsg.self, from: data)).map { .decision($0) }
        case "order":
            return (try? decoder.decode(OrderMsg.self, from: data)).map { .order($0) }
        case "error":
            return (try? decoder.decode(ErrorMsg.self, from: data)).map { .error($0) }
        default:
            return .unknown(env.type)
        }
    }
}
