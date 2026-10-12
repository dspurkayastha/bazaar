import Foundation

enum WSEvent {
    case open
    case text(String)
    case binary(Data)
    case closed(code: Int, reason: String)
}

/// One WebSocket connection attempt. Create a new instance per (re)connect.
/// `onEvent` is always invoked on the main queue, in order. After `.closed` (or after
/// `close()`), no further events are delivered.
final class WebSocketConnection: NSObject, URLSessionWebSocketDelegate {
    var onEvent: ((WSEvent) -> Void)?

    private let url: URL
    private let token: String
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var isOpen = false
    private var finished = false

    init(url: URL, token: String) {
        self.url = url
        self.token = token
        super.init()
    }

    // MARK: Lifecycle

    func connect() {
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let newSession = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        let newTask = newSession.webSocketTask(with: request)
        lock.lock()
        session = newSession
        task = newTask
        lock.unlock()
        newTask.resume()
    }

    /// Client-initiated close. Suppresses further events.
    func close() {
        lock.lock()
        finished = true
        isOpen = false
        let t = task
        let s = session
        task = nil
        session = nil
        lock.unlock()
        t?.cancel(with: .normalClosure, reason: nil)
        s?.invalidateAndCancel()
    }

    /// Treat the connection as dead (ping failure): report `.closed(1006)` and tear down.
    func abort() {
        finish(code: 1006, reason: "aborted")
    }

    // MARK: Sending (thread-safe)

    func sendText(_ text: String, completion: (() -> Void)? = nil) {
        lock.lock()
        let t = isOpen ? task : nil
        lock.unlock()
        guard let t = t else {
            completion?()
            return
        }
        t.send(.string(text)) { _ in
            completion?()
        }
    }

    func sendBinary(_ data: Data) {
        lock.lock()
        let t = isOpen ? task : nil
        lock.unlock()
        t?.send(.data(data)) { _ in }
    }

    func sendPing(_ done: @escaping (Bool) -> Void) {
        lock.lock()
        let t = isOpen ? task : nil
        lock.unlock()
        guard let t = t else {
            done(false)
            return
        }
        t.sendPing { error in
            done(error == nil)
        }
    }

    // MARK: Receiving

    private func receiveLoop(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.emit(.text(text))
                case .data(let data):
                    self.emit(.binary(data))
                @unknown default:
                    break
                }
                self.receiveLoop(t)
            case .failure:
                // Give the delegate a moment to report the real close code first.
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) { [weak self] in
                    guard let self = self else { return }
                    let code = t.closeCode.rawValue
                    self.finish(code: code == 0 ? 1006 : code, reason: "receive failed")
                }
            }
        }
    }

    private func emit(_ event: WSEvent) {
        lock.lock()
        let alive = !finished
        lock.unlock()
        guard alive else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let stillAlive = !self.finished
            self.lock.unlock()
            if stillAlive {
                self.onEvent?(event)
            }
        }
    }

    /// Reports `.closed` exactly once, then tears the socket down.
    private func finish(code: Int, reason: String) {
        lock.lock()
        if finished {
            lock.unlock()
            return
        }
        finished = true
        isOpen = false
        let t = task
        let s = session
        task = nil
        session = nil
        lock.unlock()
        DispatchQueue.main.async { [weak self] in
            self?.onEvent?(.closed(code: code, reason: reason))
        }
        t?.cancel(with: .normalClosure, reason: nil)
        s?.invalidateAndCancel()
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol proto: String?) {
        lock.lock()
        isOpen = true
        lock.unlock()
        emit(.open)
        receiveLoop(webSocketTask)
    }

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        finish(code: closeCode.rawValue, reason: text)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        // A rejected upgrade can surface as an HTTP 401 instead of a WebSocket close frame.
        if let http = task.response as? HTTPURLResponse, http.statusCode == 401 {
            finish(code: 4401, reason: "unauthorized")
            return
        }
        if let ws = task as? URLSessionWebSocketTask, ws.closeCode.rawValue != 0 {
            finish(code: ws.closeCode.rawValue, reason: "")
            return
        }
        finish(code: 1006, reason: error?.localizedDescription ?? "")
    }
}

/// Lets the audio thread push mic frames without touching main-actor state.
final class FrameSink {
    private let lock = NSLock()
    private var connection: WebSocketConnection?

    func set(_ connection: WebSocketConnection?) {
        lock.lock()
        self.connection = connection
        lock.unlock()
    }

    func send(_ data: Data) {
        lock.lock()
        let c = connection
        lock.unlock()
        c?.sendBinary(data)
    }
}
