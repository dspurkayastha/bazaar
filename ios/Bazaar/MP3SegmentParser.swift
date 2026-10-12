import AudioToolbox
import Foundation

/// Parses one MP3 segment (one audio_start ... audio_end) into packets using AudioFileStream.
/// Not thread-safe: use from a single serial queue. The callbacks fire synchronously inside `parse`.
final class MP3SegmentParser {
    /// Fired once the stream's decoded format (AudioStreamBasicDescription) is known.
    var onFormat: ((AudioStreamBasicDescription) -> Void)?
    /// Fired with contiguous packet data and descriptions whose offsets are relative to that data.
    var onPackets: ((Data, [AudioStreamPacketDescription]) -> Void)?

    private var stream: AudioFileStreamID?
    private var selfRef: Unmanaged<MP3SegmentParser>?

    init?() {
        let ref = Unmanaged.passRetained(self)
        var id: AudioFileStreamID?
        let status = AudioFileStreamOpen(
            ref.toOpaque(),
            { clientData, streamID, propertyID, _ in
                let me = Unmanaged<MP3SegmentParser>.fromOpaque(clientData).takeUnretainedValue()
                me.handleProperty(streamID, propertyID)
            },
            { clientData, numberBytes, numberPackets, inputData, packetDescriptions in
                let me = Unmanaged<MP3SegmentParser>.fromOpaque(clientData).takeUnretainedValue()
                me.handlePackets(numberBytes, numberPackets, inputData, packetDescriptions)
            },
            kAudioFileMP3Type,
            &id
        )
        guard status == noErr, let opened = id else {
            ref.release()
            return nil
        }
        stream = opened
        selfRef = ref
    }

    /// Feed raw MP3 bytes. Returns false if the parser rejected the data.
    @discardableResult
    func parse(_ data: Data) -> Bool {
        guard let s = stream, !data.isEmpty else { return false }
        let status: OSStatus = data.withUnsafeBytes { raw in
            AudioFileStreamParseBytes(s, UInt32(raw.count), raw.baseAddress, [])
        }
        return status == noErr
    }

    func close() {
        if let s = stream {
            AudioFileStreamClose(s)
            stream = nil
        }
        selfRef?.release()
        selfRef = nil
    }

    private func handleProperty(_ streamID: AudioFileStreamID, _ propertyID: AudioFileStreamPropertyID) {
        guard propertyID == kAudioFileStreamProperty_DataFormat else { return }
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioFileStreamGetProperty(streamID, propertyID, &size, &asbd)
        if status == noErr {
            onFormat?(asbd)
        }
    }

    private func handlePackets(_ numberBytes: UInt32,
                               _ numberPackets: UInt32,
                               _ inputData: UnsafeRawPointer,
                               _ descriptions: UnsafeMutablePointer<AudioStreamPacketDescription>?) {
        guard let descriptions = descriptions, numberPackets > 0 else { return }
        var data = Data()
        var rebased: [AudioStreamPacketDescription] = []
        rebased.reserveCapacity(Int(numberPackets))
        for i in 0..<Int(numberPackets) {
            let d = descriptions[i]
            let offset = Int(d.mStartOffset)
            let size = Int(d.mDataByteSize)
            guard offset >= 0, size > 0, offset + size <= Int(numberBytes) else { continue }
            let newDesc = AudioStreamPacketDescription(
                mStartOffset: Int64(data.count),
                mVariableFramesInPacket: d.mVariableFramesInPacket,
                mDataByteSize: d.mDataByteSize
            )
            data.append(Data(bytes: inputData + offset, count: size))
            rebased.append(newDesc)
        }
        if !rebased.isEmpty {
            onPackets?(data, rebased)
        }
    }
}
