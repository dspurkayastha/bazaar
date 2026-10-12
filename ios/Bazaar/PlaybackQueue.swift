import AudioToolbox
import Foundation

/// Thin wrapper over one AudioQueue output queue playing compressed (MP3) packets.
/// All methods except the output callback must be called from one serial queue
/// (MP3StreamPlayer's). The callback only touches `pending` under `lock`.
final class PlaybackQueue {
    let format: AudioStreamBasicDescription
    /// Called (on an AudioQueue thread) when the last queued buffer finished playing.
    var onDrained: (() -> Void)?

    private var queue: AudioQueueRef?
    private var selfRef: Unmanaged<PlaybackQueue>?
    private let lock = NSLock()
    private var pending = 0
    private var started = false

    private static let outputCallback: AudioQueueOutputCallback = { userData, queue, buffer in
        guard let userData = userData else { return }
        let me = Unmanaged<PlaybackQueue>.fromOpaque(userData).takeUnretainedValue()
        AudioQueueFreeBuffer(queue, buffer)
        me.bufferFinished()
    }

    init?(format: AudioStreamBasicDescription) {
        self.format = format
        let ref = Unmanaged.passRetained(self)
        var fmt = format
        var created: AudioQueueRef?
        let status = AudioQueueNewOutput(&fmt, PlaybackQueue.outputCallback, ref.toOpaque(), nil, nil, 0, &created)
        guard status == noErr, let q = created else {
            ref.release()
            return nil
        }
        queue = q
        selfRef = ref
        var on: UInt32 = 1
        AudioQueueSetProperty(q, kAudioQueueProperty_EnableLevelMetering, &on, UInt32(MemoryLayout<UInt32>.size))
    }

    var pendingBuffers: Int {
        lock.lock()
        defer { lock.unlock() }
        return pending
    }

    /// Copies `data` into a new AudioQueue buffer and enqueues it. Starts the queue on first use.
    @discardableResult
    func enqueue(_ data: Data, descriptions: [AudioStreamPacketDescription]) -> Bool {
        guard let q = queue, !data.isEmpty, !descriptions.isEmpty else { return false }
        var allocated: AudioQueueBufferRef?
        let allocStatus = AudioQueueAllocateBufferWithPacketDescriptions(
            q, UInt32(data.count), UInt32(descriptions.count), &allocated)
        guard allocStatus == noErr, let buffer = allocated else { return false }
        data.withUnsafeBytes { raw in
            if let base = raw.baseAddress {
                memcpy(buffer.pointee.mAudioData, base, data.count)
            }
        }
        buffer.pointee.mAudioDataByteSize = UInt32(data.count)
        lock.lock()
        pending += 1
        lock.unlock()
        let enqueueStatus: OSStatus = descriptions.withUnsafeBufferPointer { ptr in
            AudioQueueEnqueueBuffer(q, buffer, UInt32(descriptions.count), ptr.baseAddress)
        }
        if enqueueStatus != noErr {
            AudioQueueFreeBuffer(q, buffer)
            lock.lock()
            pending -= 1
            lock.unlock()
            return false
        }
        if !started {
            started = (AudioQueueStart(q, nil) == noErr)
        }
        return true
    }

    /// Linear 0...1 average output level (0 if unavailable).
    func level() -> Float {
        guard let q = queue, started else { return 0 }
        let channels = max(1, Int(format.mChannelsPerFrame))
        var meters = [AudioQueueLevelMeterState](repeating: AudioQueueLevelMeterState(), count: channels)
        var size = UInt32(MemoryLayout<AudioQueueLevelMeterState>.size * channels)
        let status = AudioQueueGetProperty(q, kAudioQueueProperty_CurrentLevelMeter, &meters, &size)
        guard status == noErr, let first = meters.first else { return 0 }
        return min(1, max(0, first.mAveragePower))
    }

    /// Stops immediately, discards everything queued, and frees the queue.
    func dispose() {
        onDrained = nil
        guard let q = queue else { return }
        queue = nil
        AudioQueueStop(q, true)
        AudioQueueDispose(q, true)
        selfRef?.release()
        selfRef = nil
    }

    private func bufferFinished() {
        lock.lock()
        pending -= 1
        let drained = pending <= 0
        lock.unlock()
        if drained {
            onDrained?()
        }
    }
}
