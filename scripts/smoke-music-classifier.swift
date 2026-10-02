import AVFoundation
import SoundAnalysis

/// Offline smoke of the actual Apple classifier. Generated PCM stays in memory; no microphone is opened.
final class MusicClassifierProbe: NSObject, SNResultsObserving {
    private let lock = NSLock()
    private var rows: [[String: Any]] = []
    private var failure: String?
    private let completed = DispatchSemaphore(value: 0)

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        let music = result.classifications.first { $0.identifier == "music" }?.confidence ?? 0
        let speech = result.classifications.first { $0.identifier == "speech" }?.confidence ?? 0
        let vocals = result.classifications.filter { ["singing", "choir_singing"].contains($0.identifier) }.map(\.confidence).max() ?? 0
        lock.lock(); defer { lock.unlock() }
        rows.append(["time": CMTimeGetSeconds(CMTimeRangeGetEnd(result.timeRange)), "music": music, "speech": speech, "vocals": vocals,
                     "top": result.classifications.prefix(3).map { ["label": $0.identifier, "confidence": $0.confidence] }])
    }
    func request(_ request: SNRequest, didFailWithError error: Error) {
        lock.lock(); failure = error.localizedDescription; lock.unlock(); completed.signal()
    }
    func requestDidComplete(_ request: SNRequest) { completed.signal() }

    func analyze(_ buffer: AVAudioPCMBuffer, name: String) throws -> [String: Any] {
        let analyzer = SNAudioStreamAnalyzer(format: buffer.format)
        let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
        request.windowDuration = CMTime(seconds: 1.5, preferredTimescale: 16000); request.overlapFactor = 0.5
        try analyzer.add(request, withObserver: self)
        analyzer.analyze(buffer, atAudioFramePosition: 0); analyzer.completeAnalysis()
        guard completed.wait(timeout: .now() + 30) == .success else { throw NSError(domain: "ClassifierSmoke", code: 1, userInfo: [NSLocalizedDescriptionKey: "Classifier timed out"]) }
        lock.lock(); defer { lock.unlock() }
        if let failure { throw NSError(domain: "ClassifierSmoke", code: 2, userInfo: [NSLocalizedDescriptionKey: failure]) }
        precondition(!rows.isEmpty, "Classifier produced no results")
        var gate = MusicClassificationGate(), admitted = 0
        for row in rows {
            let time = row["time"] as! Double
            gate.update(music: row["music"] as! Double, speech: row["speech"] as! Double, vocals: row["vocals"] as! Double, at: time)
            if gate.allowance(at: time + 0.4) > 0.5 { admitted += 1 }
        }
        return ["name": name, "windows": rows, "gateAdmittedWindows": admitted]
    }
}

@main struct MusicClassifierSmoke {
    static func main() throws {
        let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
        let signal = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16000 * 12)!
        signal.frameLength = signal.frameCapacity
        for index in 0..<Int(signal.frameLength) {
            let time = Double(index) / format.sampleRate, beat = time.truncatingRemainder(dividingBy: 0.5)
            let chord = [220.0, 261.6256, 329.6276][Int(time / 2) % 3]
            let kick = sin(2 * Double.pi * 80 * time) * exp(-beat * 40) * 0.55
            let note = sin(2 * Double.pi * chord * time) * 0.09 + sin(2 * Double.pi * chord * 1.5 * time) * 0.06
            let hat = sin(2 * Double.pi * 3100 * time) * exp(-time.truncatingRemainder(dividingBy: 0.25) * 90) * 0.11
            signal.floatChannelData![0][index] = Float(kick + note + hat)
        }
        var results = [try MusicClassifierProbe().analyze(signal, name: "generated-rhythmic-tones-120bpm")]
        for path in CommandLine.arguments.dropFirst() {
            let file = try AVAudioFile(forReading: URL(fileURLWithPath: path), commonFormat: .pcmFormatFloat32, interleaved: false)
            let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(min(file.length, Int64(file.processingFormat.sampleRate * 15))))!
            try file.read(into: buffer)
            results.append(try MusicClassifierProbe().analyze(buffer, name: URL(fileURLWithPath: path).lastPathComponent))
        }
        print(String(data: try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
    }
}
