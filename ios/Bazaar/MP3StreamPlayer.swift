import AudioToolbox
import Foundation

/// Streaming MP3 player: AudioFileStream (parse) -> AudioQueue (decode + play).
///
/// - One parser per segment, one AudioQueue shared across segments, so segments that follow
///   each other are enqueued back to back with no gap added by this layer.
/// - `stop()` disposes the queue immediately (AudioQueueStop immediate + Dispose), discarding
///   everything queued; the next segment creates a fresh queue.
/// - All public methods are safe to call from the main thread; work runs on a private serial queue.
final class MP3StreamPlayer {
    /// Called on an arbitrary thread when all queued audio has finished playing.
    var onDrained: (() -> Void)?

    /// Enqueue to the AudioQueue once this much audio (seconds) is staged.
    private static let flushSeconds: Double = 0.12

    private let q = DispatchQueue(label: "com.sciscribe.bazaar.player")
    private var parser: MP3SegmentParser?
    private var playback: PlaybackQueue?
    private var format: AudioStreamBasicDescription?
    private var accepting = false
    private var stagedData = Data()
    private var stagedDescriptions: [AudioStreamPacketDescription] = []
    private var stagedSeconds: Double = 0

    // MARK: Public API

    func beginSegment() {
        q.async {
            self.closeParser(flush: true)
            guard let p = MP3SegmentParser() else {
                self.accepting = false
                return
            }
            p.onFormat = { [weak self] asbd in
                self?.formatKnown(asbd)
            }
            p.onPackets = { [weak self] data, descriptions in
                self?.packetsParsed(data, descriptions)
            }
            self.parser = p
            self.accepting = true
        }
    }

    func append(_ data: Data) {
        q.async {
            guard self.accepting, let p = self.parser else { return }
            p.parse(data)
        }
    }

    func endSegment() {
        q.async {
            self.closeParser(flush: true)
            self.accepting = false
        }
    }

    /// Synchronous so playback is silent by the time this returns.
    func stop() {
        q.sync {
            self.accepting = false
            self.closeParser(flush: false)
            self.stagedData.removeAll()
            self.stagedDescriptions.removeAll()
            self.stagedSeconds = 0
            self.playback?.dispose()
            self.playback = nil
            self.format = nil
        }
    }

    func currentLevel() -> Float {
        return q.sync { self.playback?.level() ?? 0 }
    }

    func isBusy() -> Bool {
        return q.sync {
            guard let pb = self.playback else { return self.accepting }
            return self.accepting || pb.pendingBuffers > 0
        }
    }

    // MARK: Private (run on q)

    private func closeParser(flush: Bool) {
        parser?.close()
        parser = nil
        if flush {
            flushStaged()
        }
    }

    private func formatKnown(_ asbd: AudioStreamBasicDescription) {
        if playback != nil, let current = format,
           current.mSampleRate == asbd.mSampleRate,
           current.mChannelsPerFrame == asbd.mChannelsPerFrame,
           current.mFormatID == asbd.mFormatID {
            return
        }
        playback?.dispose()
        playback = nil
        format = asbd
        let created = PlaybackQueue(format: asbd)
        created?.onDrained = { [weak self] in
            self?.onDrained?()
        }
        playback = created
    }

    private func packetsParsed(_ data: Data, _ descriptions: [AudioStreamPacketDescription]) {
        guard accepting, let fmt = format else { return }
        let base = Int64(stagedData.count)
        stagedData.append(data)
        for d in descriptions {
            stagedDescriptions.append(AudioStreamPacketDescription(
                mStartOffset: d.mStartOffset + base,
                mVariableFramesInPacket: d.mVariableFramesInPacket,
                mDataByteSize: d.mDataByteSize))
        }
        let framesPerPacket = fmt.mFramesPerPacket > 0 ? Double(fmt.mFramesPerPacket) : 1152
        if fmt.mSampleRate > 0 {
            stagedSeconds += Double(descriptions.count) * framesPerPacket / fmt.mSampleRate
        }
        if stagedSeconds >= MP3StreamPlayer.flushSeconds {
            flushStaged()
        }
    }

    private func flushStaged() {
        defer {
            stagedData.removeAll(keepingCapacity: true)
            stagedDescriptions.removeAll(keepingCapacity: true)
            stagedSeconds = 0
        }
        guard !stagedData.isEmpty, let pb = playback else { return }
        pb.enqueue(stagedData, descriptions: stagedDescriptions)
    }
}
