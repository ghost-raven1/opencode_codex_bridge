import AVFoundation
import SoundAnalysis

/// A bounded in-memory analysis queue. Only beat metadata crosses back to the main thread.
final class MusicAnalysis: NSObject, SNResultsObserving {
    var onBeat: ((MusicBeatState) -> Void)?
    var onError: ((String) -> Void)?
    private let queue = DispatchQueue(label: "dev.codexbridge.music-analysis", qos: .utility)
    private let work = MusicWorkGate()
    private let analyzer: SNAudioStreamAnalyzer
    private var rhythm: MusicRhythm
    private var classification = MusicClassificationGate()
    private var firstFrame: Int64?, reference: Double?
    private var fallbackFrame: Int64 = 0

    init(format: AVAudioFormat) throws {
        analyzer = SNAudioStreamAnalyzer(format: format)
        rhythm = MusicRhythm(sampleRate: format.sampleRate)
        super.init()
        let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
        guard request.knownClassifications.contains("music"), request.knownClassifications.contains("speech") else {
            throw NSError(domain: "CodexBridgeMusic", code: 1, userInfo: [NSLocalizedDescriptionKey: "Системный классификатор музыки недоступен."])
        }
        request.windowDuration = CMTime(seconds: 1.5, preferredTimescale: 16000)
        request.overlapFactor = 0.5
        try analyzer.add(request, withObserver: self)
    }

    func submit(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
        let frame = time.isSampleTimeValid ? time.sampleTime : fallbackFrame
        fallbackFrame += Int64(buffer.frameLength)
        guard work.reserve() else { return }
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { work.release(); return }
        copy.frameLength = buffer.frameLength
        let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for index in source.indices {
            if let input = source[index].mData, let output = destination[index].mData {
                memcpy(output, input, min(Int(source[index].mDataByteSize), Int(destination[index].mDataByteSize)))
            }
        }
        let captured = Date.timeIntervalSinceReferenceDate
        queue.async { [weak self] in
            guard let self else { return }
            defer { self.work.release() }
            guard !self.work.isClosed, let samples = copy.floatChannelData?[0] else { return }
            if self.firstFrame == nil { self.firstFrame = frame; self.reference = captured }
            let position = frame - self.firstFrame!
            self.rhythm.consume(samples, count: Int(copy.frameLength), stride: copy.format.isInterleaved ? Int(copy.format.channelCount) : 1, frame: position)
            self.analyzer.analyze(copy, atAudioFramePosition: position)
            var state = self.rhythm.state
            state.allowance = self.classification.allowance(at: state.measuredAt)
            state.classification = self.classification.label
            state.classificationConfidence = self.classification.confidence
            let reference = self.reference!
            state.anchor += reference; state.audibleAt += reference; state.measuredAt += reference
            let output = state
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.work.isClosed else { return }
                self.onBeat?(output)
            }
        }
    }

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        let music = result.classifications.first { $0.identifier == "music" }?.confidence ?? 0
        let vocals = result.classifications.filter { ["singing", "choir_singing"].contains($0.identifier) }.map(\.confidence).max() ?? 0
        let speech = result.classifications.first { $0.identifier == "speech" }?.confidence ?? 0
        let time = CMTimeGetSeconds(CMTimeRangeGetEnd(result.timeRange))
        queue.async { [weak self] in
            guard let self, !self.work.isClosed else { return }
            self.classification.update(music: music, speech: speech, vocals: vocals, at: time)
        }
    }

    func request(_ request: SNRequest, didFailWithError error: Error) {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.work.isClosed else { return }
            self.onError?("Распознавание музыки остановлено: \(error.localizedDescription)")
        }
    }

    func stop() { work.close(); queue.async { [self] in analyzer.removeAllRequests() } }
}
