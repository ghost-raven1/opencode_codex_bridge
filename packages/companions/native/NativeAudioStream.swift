import AVFoundation

/// Validates the producer and keeps at most twelve seconds of unconsumed PCM in memory.
@MainActor final class NativeAudioStream {
    var onAccepted: ((Int) -> Void)?
    var onConsumed: ((Int) -> Void)?
    var onStarted: (() -> Void)?
    var onBuffering: ((Bool, Double) -> Void)?
    var onLevel: ((Double) -> Void)?
    var onProgress: ((Double, Double?, Double) -> Void)?
    var onFinished: ((String) -> Void)?
    private let output: NativeAudioOutput
    private var format: AVAudioFormat?
    private var durations: [Int: Double] = [:]
    private var nextIndex = 0, nextConsumed = 0
    private var ended = false, terminated = false, playing = false, rendered = false, forced = false
    private var generatedSeconds = 0.0, consumedSeconds = 0.0, playedSeconds = 0.0
    private var lastPosition: Double?
    private(set) var buffering = false
    var bufferedSeconds: Double { durations.values.reduce(0, +) }

    convenience init() { self.init(output: NativeAudioEngine()) }

    init(output: NativeAudioOutput) {
        self.output = output
        output.onConsumed = { [weak self] index in self?.consumed(index) }
        output.onRendered = { [weak self] level, position in self?.rendered(level, position: position) }
        output.onFailure = { [weak self] in self?.finish("error") }
    }

    func append(index: Int, path: String, duration: Double, sampleRate: Double) {
        guard !terminated else { return }
        do {
            guard !ended, index == nextIndex, duration.isFinite, duration > 0, duration <= 12,
                  sampleRate.isFinite, (8_000...192_000).contains(sampleRate),
                  bufferedSeconds + duration <= 12.001 else { throw StreamFailure.invalidChunk }
            let file = try AVAudioFile(forReading: URL(fileURLWithPath: path), commonFormat: .pcmFormatFloat32, interleaved: false)
            let actual = Double(file.length) / file.processingFormat.sampleRate
            guard file.length > 0, actual <= 12, abs(actual - duration) <= 0.002,
                  file.processingFormat.sampleRate == sampleRate, (1...2).contains(file.processingFormat.channelCount),
                  bufferedSeconds + actual <= 12.001 else { throw StreamFailure.invalidChunk }
            if let format {
                guard format.sampleRate == sampleRate, format.channelCount == file.processingFormat.channelCount else {
                    throw StreamFailure.formatChanged
                }
            } else {
                try output.prepare(format: file.processingFormat); format = file.processingFormat
            }
            guard let pcm = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)) else {
                throw StreamFailure.invalidChunk
            }
            try file.read(into: pcm)
            guard pcm.frameLength == file.length else { throw StreamFailure.invalidChunk }
            if buffering { lastPosition = nil }
            generatedSeconds += actual; durations[index] = actual; nextIndex += 1
            output.schedule(pcm, index: index)
            onAccepted?(index)
            guard !terminated else { return }
            setBuffering(false)
            try startIfReady()
        } catch { finish("error") }
    }

    func end(chunks: Int) {
        guard !terminated else { return }
        guard !ended, chunks == nextIndex, chunks > 0 else { finish("error"); return }
        ended = true
        if durations.isEmpty { finish("end"); return }
        do { try startIfReady() } catch { finish("error") }
    }

    /// The router owns the twenty-second startup deadline and may release a shorter prefill.
    func forcePlay() {
        guard !terminated else { return }
        forced = true
        do { try startIfReady() } catch { finish("error") }
    }

    func cancel() { finish("cancel") }

    private func startIfReady() throws {
        guard !terminated, !playing, !durations.isEmpty, bufferedSeconds >= 4 || ended || forced else { return }
        playing = true
        try output.play()
    }

    private func rendered(_ level: Double, position: Double) {
        guard !terminated, playing, !durations.isEmpty else { return }
        if !rendered { rendered = true; onStarted?() }
        guard !terminated else { return }
        onLevel?(level)
        if position.isFinite, position >= 0 {
            let delta = max(0, position - (lastPosition ?? position))
            lastPosition = position
            playedSeconds = min(generatedSeconds, max(consumedSeconds, playedSeconds + delta))
            onProgress?(playedSeconds, ended ? generatedSeconds : nil, level)
        }
    }

    private func consumed(_ index: Int) {
        guard !terminated else { return }
        guard index == nextConsumed, let duration = durations.removeValue(forKey: index) else { finish("error"); return }
        consumedSeconds += duration; playedSeconds = max(playedSeconds, consumedSeconds)
        nextConsumed += 1
        onConsumed?(index)
        guard !terminated else { return }
        if durations.isEmpty {
            onLevel?(0)
            if ended { finish("end") } else { setBuffering(true) }
        }
    }

    private func setBuffering(_ value: Bool) {
        guard buffering != value else { return }
        buffering = value
        if value { lastPosition = nil; onLevel?(0) }
        onBuffering?(value, bufferedSeconds)
    }

    private func finish(_ phase: String) {
        guard !terminated else { return }
        terminated = true; durations.removeAll(); output.stop()
        onLevel?(0)
        onFinished?(phase)
    }

    private enum StreamFailure: Error { case invalidChunk, formatChanged }
}
