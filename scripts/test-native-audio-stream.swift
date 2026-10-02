import AppKit
import AVFoundation

@MainActor final class TestAudioOutput: NativeAudioOutput {
    var onConsumed: ((Int) -> Void)?
    var onRendered: ((Double) -> Void)?
    var onFailure: (() -> Void)?
    var buffers: [Int: AVAudioPCMBuffer] = [:]
    var plays = 0, stops = 0, prepares = 0
    var failPlay = false
    func prepare(format: AVAudioFormat) throws { prepares += 1 }
    func schedule(_ buffer: AVAudioPCMBuffer, index: Int) { buffers[index] = buffer }
    func play() throws { if failPlay { throw NSError(domain: "test", code: 1) }; plays += 1 }
    func stop() { stops += 1 }
    func consume(_ index: Int) { onConsumed?(index) }
    func render(_ level: Double = 0.6) { onRendered?(level) }
}

@main struct NativeAudioStreamTests {
    @MainActor static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        func wav(_ seconds: Double = 2, rate: Double = 24_000, channels: AVAudioChannelCount = 1) throws -> String {
            let url = directory.appendingPathComponent(UUID().uuidString + ".wav")
            let frames = UInt32(seconds * rate), bytes = frames * channels * 2
            var data = Data()
            func text(_ value: String) { data.append(contentsOf: value.utf8) }
            func number<T: FixedWidthInteger>(_ value: T) {
                var little = value.littleEndian
                withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
            }
            text("RIFF"); number(bytes + 36); text("WAVEfmt "); number(UInt32(16)); number(UInt16(1))
            number(UInt16(channels)); number(UInt32(rate)); number(UInt32(rate) * channels * 2)
            number(UInt16(channels * 2)); number(UInt16(16)); text("data"); number(bytes)
            for _ in 0..<(frames * channels) { number(Int16(3277)) }
            try data.write(to: url)
            return url.path
        }
        let two = try wav(), short = try wav(0.5), stereo = try wav(channels: 2), rateChanged = try wav(rate: 48_000)

        let output = TestAudioOutput(), stream = NativeAudioStream(output: output)
        var accepted: [Int] = [], consumed: [Int] = [], phases: [String] = [], buffering: [Bool] = [], levels: [Double] = []
        var starts = 0
        stream.onAccepted = { accepted.append($0) }; stream.onConsumed = { consumed.append($0) }
        stream.onStarted = { starts += 1 }; stream.onFinished = { phases.append($0) }
        stream.onBuffering = { value, _ in buffering.append(value) }; stream.onLevel = { levels.append($0) }
        stream.append(index: 0, path: two, duration: 2, sampleRate: 24_000)
        precondition(output.plays == 0 && accepted == [0] && consumed.isEmpty && starts == 0,
                     "Initial chunk: accepted=\(accepted), phases=\(phases), prepares=\(output.prepares)")
        stream.append(index: 1, path: two, duration: 2, sampleRate: 24_000)
        precondition(output.plays == 1 && output.prepares == 1 && starts == 0 && stream.bufferedSeconds == 4)
        output.render(); output.render()
        precondition(starts == 1 && levels.last == 0.6, "Queued PCM must not animate the mouth before playback")
        output.consume(0); precondition(consumed == [0] && stream.bufferedSeconds == 2)
        output.consume(1)
        precondition(buffering == [true] && levels.last == 0 && phases.isEmpty)
        output.render(); precondition(levels.last == 0, "Starved streams must keep the mouth closed")
        stream.append(index: 2, path: two, duration: 2, sampleRate: 24_000)
        precondition(buffering == [true, false] && output.plays == 1, "Resume must not restart the audio device")
        stream.end(chunks: 3); precondition(phases.isEmpty)
        output.consume(2); precondition(phases == ["end"] && consumed == [0, 1, 2] && output.stops == 1)
        output.consume(2); output.render(); stream.forcePlay(); stream.end(chunks: 3)
        precondition(phases == ["end"] && starts == 1)

        for force in [false, true] {
            let driver = TestAudioOutput(), candidate = NativeAudioStream(output: driver)
            candidate.append(index: 0, path: short, duration: 0.5, sampleRate: 24_000)
            precondition(driver.plays == 0)
            if force { candidate.forcePlay() } else { candidate.end(chunks: 1) }
            precondition(driver.plays == 1, "Short phrases must start at producer end or explicit deadline")
            candidate.cancel()
        }

        for bad in ["sequence", "duration", "sample-rate", "format", "overflow", "end-count", "missing", "device", "play"] {
            let driver = TestAudioOutput(), candidate = NativeAudioStream(output: driver)
            var result: [String] = []; candidate.onFinished = { result.append($0) }
            if bad == "play" { driver.failPlay = true }
            candidate.append(index: 0, path: two, duration: 2, sampleRate: 24_000)
            switch bad {
            case "sequence": candidate.append(index: 2, path: two, duration: 2, sampleRate: 24_000)
            case "duration": candidate.append(index: 1, path: two, duration: .nan, sampleRate: 24_000)
            case "sample-rate": candidate.append(index: 1, path: rateChanged, duration: 2, sampleRate: 48_000)
            case "format": candidate.append(index: 1, path: stereo, duration: 2, sampleRate: 24_000)
            case "overflow": for index in 1...6 { candidate.append(index: index, path: two, duration: 2, sampleRate: 24_000) }
            case "end-count": candidate.end(chunks: 2)
            case "missing": candidate.append(index: 1, path: "/missing.wav", duration: 2, sampleRate: 24_000)
            case "device": driver.onFailure?()
            default: candidate.forcePlay()
            }
            precondition(result == ["error"] && driver.stops == 1, "Expected exactly one error for \(bad)")
            candidate.cancel(); driver.consume(0); precondition(result == ["error"])
        }
        let credited = TestAudioOutput(), bounded = NativeAudioStream(output: credited)
        for index in 0..<6 { bounded.append(index: index, path: two, duration: 2, sampleRate: 24_000) }
        precondition(bounded.bufferedSeconds == 12)
        credited.consume(0); bounded.append(index: 6, path: two, duration: 2, sampleRate: 24_000)
        precondition(bounded.bufferedSeconds == 12 && credited.buffers.count == 7)
        bounded.cancel()

        let copied = TestAudioOutput(), independent = NativeAudioStream(output: copied), disposable = try wav()
        independent.onAccepted = { _ in try! FileManager.default.removeItem(atPath: disposable) }
        independent.append(index: 0, path: disposable, duration: 2, sampleRate: 24_000)
        precondition(abs((copied.buffers[0]?.floatChannelData?[0][0] ?? 0) - 0.1) < 0.0001,
                     "Accepted WAV must already live in a native PCM buffer")
        independent.cancel()

        let speech = NativeSpeech()
        var drivers: [TestAudioOutput] = [], finished: [String] = [], audioStarts = 0, drained = 0
        speech.makeStream = { let driver = TestAudioOutput(); drivers.append(driver); return NativeAudioStream(output: driver) }
        speech.onAudioStarted = { _ in audioStarts += 1 }; speech.onDrained = { drained += 1 }
        speech.onAudioFinished = { id, phase in
            finished.append(id + ":" + phase)
            if id == "first" { speech.startStream(characterId: "agent", text: "Second", audioId: "second") }
        }
        speech.startStream(characterId: "agent", text: "First", audioId: "first")
        speech.appendStream(audioId: "first", index: 0, path: short, duration: 0.5, sampleRate: 24_000)
        speech.endStream(audioId: "first", chunks: 1); drivers[0].render(); drivers[0].consume(0)
        precondition(finished == ["first:end"] && drivers.count == 2 && speech.playbackPhase == "queued" && drained == 0,
                     "A terminal callback can start the next stream only after old state is detached")
        speech.startStream(characterId: "agent", text: "Late", audioId: "first")
        speech.endStream(audioId: "first", chunks: 1); drivers[0].render(); drivers[0].consume(0)
        precondition(drivers.count == 2 && finished.count == 1 && audioStarts == 1)
        speech.suspended = true
        precondition(finished == ["first:end", "second:cancel"] && speech.playbackPhase == nil)
        speech.suspended = false; speech.startStream(characterId: "agent", text: "Late", audioId: "second")
        precondition(drivers.count == 2 && speech.playbackPhase == nil)
        speech.startStream(characterId: "agent", text: "Third", audioId: "third"); speech.setMuted(true)
        precondition(finished.last == "third:cancel" && speech.playbackPhase == nil && drivers.last?.stops == 1)
        print("PASS streaming prefill/short/deadline, PCM ownership, playback-only credits/mouth, buffer/resume, 12s cap, sequence/format failures, cancellation, stale callbacks and reentrant next stream; no audio played")
    }
}
