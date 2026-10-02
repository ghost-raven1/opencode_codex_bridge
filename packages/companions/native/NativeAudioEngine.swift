import AVFoundation

/// The stream owns PCM buffers; the output reports credit only after speakers consumed them.
@MainActor protocol NativeAudioOutput: AnyObject {
    var onConsumed: ((Int) -> Void)? { get set }
    var onRendered: ((Double) -> Void)? { get set }
    var onFailure: (() -> Void)? { get set }
    func prepare(format: AVAudioFormat) throws
    func schedule(_ buffer: AVAudioPCMBuffer, index: Int)
    func play() throws
    func stop()
}

/// One running device for the entire utterance, including short producer underruns.
@MainActor final class NativeAudioEngine: NativeAudioOutput {
    var onConsumed: ((Int) -> Void)?
    var onRendered: ((Double) -> Void)?
    var onFailure: (() -> Void)?
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var generation = UUID()
    private var prepared = false, playing = false, tapped = false, deliveredRender = false
    private var configurationObserver: NSObjectProtocol?

    func prepare(format: AVAudioFormat) throws {
        guard !prepared else { return }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        let generation = self.generation
        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
            let level = Self.rms(buffer)
            DispatchQueue.main.async {
                guard let self, self.generation == generation, self.playing,
                      let time = self.player.lastRenderTime,
                      let position = self.player.playerTime(forNodeTime: time), position.sampleTime > 0 else { return }
                self.deliveredRender = true; self.onRendered?(level)
            }
        }
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange,
            object: engine, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.playing else { return }; self.onFailure?()
                }
            }
        tapped = true; prepared = true
    }

    func schedule(_ buffer: AVAudioPCMBuffer, index: Int) {
        let generation = self.generation
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.generation == generation, self.playing else { return }
                // A very short final buffer can complete before a full metering tap arrives.
                if !self.deliveredRender { self.deliveredRender = true; self.onRendered?(0) }
                guard self.generation == generation, self.playing else { return }
                self.onConsumed?(index)
            }
        }
    }

    func play() throws {
        guard !playing else { return }
        engine.prepare(); try engine.start()
        playing = true; player.play()
    }

    func stop() {
        generation = UUID(); playing = false
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = nil
        player.stop()
        if tapped { engine.mainMixerNode.removeTap(onBus: 0); tapped = false }
        engine.stop()
    }

    /// Meter the PCM leaving the mixer, never audio that is merely generated or queued.
    nonisolated private static func rms(_ buffer: AVAudioPCMBuffer) -> Double {
        guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        var energy: Double = 0
        for channel in 0..<Int(buffer.format.channelCount) {
            for frame in 0..<Int(buffer.frameLength) {
                let sample = Double(channels[channel][frame]); energy += sample * sample
            }
        }
        let samples = Double(buffer.frameLength) * Double(buffer.format.channelCount)
        return min(1, max(0, (20 * log10(max(0.000_01, sqrt(energy / samples))) + 45) / 35))
    }
}
