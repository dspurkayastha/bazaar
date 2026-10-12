import AVFoundation
import Foundation

enum MicError: Error {
    case noInput
    case formatUnavailable
}

/// Thread-safe float holder (written on the audio thread, read on main).
final class LevelBox {
    private let lock = NSLock()
    private var stored: Float = 0

    var value: Float {
        get {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
        set {
            lock.lock()
            stored = newValue
            lock.unlock()
        }
    }
}

/// Captures the microphone with AVAudioEngine and emits 16 kHz mono Int16 LE frames of
/// `chunkBytes` bytes (1280 B = 640 samples = 40 ms).
final class MicCapture {
    /// Set to false to skip engine-level voice processing and rely on the session mode only.
    static var useVoiceProcessing = true
    static let chunkBytes = 1280
    static let targetRate: Double = 16000

    let engine = AVAudioEngine()
    let levelBox = LevelBox()
    /// Called on the audio thread with exactly `chunkBytes` bytes.
    var onChunk: ((Data) -> Void)?

    private var converter: AVAudioConverter?
    private var monoFormat: AVAudioFormat?
    private var targetFormat: AVAudioFormat?
    private var pending = Data()
    private(set) var isRunning = false

    var level: Float { levelBox.value }

    func start() throws {
        guard !isRunning else { return }
        do {
            try startEngine(voiceProcessing: MicCapture.useVoiceProcessing)
        } catch {
            // Voice processing can fail on odd routes; retry once without it.
            teardown()
            try startEngine(voiceProcessing: false)
        }
        isRunning = true
    }

    func stop() {
        teardown()
        isRunning = false
        levelBox.value = 0
    }

    private func teardown() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        pending.removeAll()
    }

    private func startEngine(voiceProcessing: Bool) throws {
        let input = engine.inputNode
        if voiceProcessing {
            try input.setVoiceProcessingEnabled(true)
        } else if input.isVoiceProcessingEnabled {
            try input.setVoiceProcessingEnabled(false)
        }
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else { throw MicError.noInput }
        guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                       sampleRate: inFormat.sampleRate,
                                       channels: 1,
                                       interleaved: false),
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                         sampleRate: MicCapture.targetRate,
                                         channels: 1,
                                         interleaved: true),
              let conv = AVAudioConverter(from: mono, to: target) else {
            throw MicError.formatUnavailable
        }
        monoFormat = mono
        targetFormat = target
        converter = conv
        pending.removeAll()
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buffer, _ in
            self?.process(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    // Runs on the audio tap thread.
    private func process(_ buffer: AVAudioPCMBuffer) {
        guard let conv = converter, let mono = monoFormat, let target = targetFormat else { return }
        let frames = Int(buffer.frameLength)
        guard frames > 0, let src = buffer.floatChannelData else { return }

        // Voice processing may deliver several channels; use channel 0 only.
        guard let monoBuffer = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength),
              let dst = monoBuffer.floatChannelData else { return }
        memcpy(dst[0], src[0], frames * MemoryLayout<Float>.size)
        monoBuffer.frameLength = buffer.frameLength

        var sum: Float = 0
        let samples = src[0]
        for i in 0..<frames {
            let v = samples[i]
            sum += v * v
        }
        let rms = (sum / Float(frames)).squareRoot()
        levelBox.value = min(1, rms * 5)

        let ratio = MicCapture.targetRate / mono.sampleRate
        let capacity = AVAudioFrameCount(Double(frames) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }

        var supplied = false
        var convError: NSError?
        let status = conv.convert(to: out, error: &convError) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return monoBuffer
        }
        if status == .error || convError != nil { return }
        guard let channel = out.int16ChannelData else { return }
        let count = Int(out.frameLength)
        if count > 0 {
            pending.append(UnsafeBufferPointer(start: channel[0], count: count))
        }
        while pending.count >= MicCapture.chunkBytes {
            let chunk = Data(pending.prefix(MicCapture.chunkBytes))
            pending.removeFirst(MicCapture.chunkBytes)
            onChunk?(chunk)
        }
    }
}
