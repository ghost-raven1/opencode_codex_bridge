import AVFoundation

/// Explicit opt-in microphone capture, independent of speech recognition and never written to disk.
@MainActor final class MusicCapture {
    var onBeat: ((MusicBeatState) -> Void)?
    var onState: ((Bool) -> Void)?
    var onError: ((String, String) -> Void)?
    private var token: UUID?
    private var engine: AVAudioEngine?
    private var analysis: MusicAnalysis?
    private var tapInstalled = false
    private var configurationObserver: NSObjectProtocol?

    func start() {
        guard token == nil else { return }
        let current = UUID(); token = current
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] allowed in
            DispatchQueue.main.async {
                guard let self, self.token == current else { return }
                guard allowed else { self.fail("Разрешите микрофон для музыкального режима в настройках macOS.", reason: "permission-denied"); return }
                self.begin(token: current)
            }
        }
    }

    private func begin(token current: UUID) {
        let engine = AVAudioEngine(), input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0, format.commonFormat == .pcmFormatFloat32 else {
            fail("Не найден доступный микрофон для музыкального режима."); return
        }
        self.engine = engine
        // Loading the system model may take time; neither permission cancellation nor UI should wait for it.
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let result = Result { try MusicAnalysis(format: format) }
            DispatchQueue.main.async {
                guard let self, self.token == current else {
                    if case .success(let analysis) = result { analysis.stop() }
                    return
                }
                switch result {
                case .success(let analysis): self.install(analysis, engine: engine, format: format, token: current)
                case .failure(let error): self.fail("Не удалось включить музыкальный режим: \(error.localizedDescription)")
                }
            }
        }
    }

    private func install(_ analysis: MusicAnalysis, engine: AVAudioEngine, format: AVAudioFormat, token current: UUID) {
        do {
            self.analysis = analysis
            analysis.onBeat = { [weak self] state in
                guard let self, self.token == current else { return }
                self.onBeat?(state)
            }
            analysis.onError = { [weak self] message in
                guard let self, self.token == current else { return }
                self.fail(message)
            }
            try MicrophoneTap.install(on: engine.inputNode, format: format) { buffer, time in analysis.submit(buffer, at: time) }
            tapInstalled = true; engine.prepare(); try engine.start(); onState?(true)
            configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.token == current else { return }
                    self.fail("Аудиоустройство изменилось. Включи музыкальный режим повторно.")
                }
            }
        } catch { fail("Не удалось включить музыкальный режим: \(error.localizedDescription)") }
    }

    func stop() {
        guard token != nil else { return }
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver); self.configurationObserver = nil }
        token = nil; engine?.stop()
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }
        analysis?.stop(); analysis = nil; engine = nil; onState?(false)
    }

    private func fail(_ message: String, reason: String = "capture-failed") { stop(); onError?(message, reason) }
}
