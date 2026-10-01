import AVFoundation
import Speech

/// A bounded microphone session started only by a user action; partial text stays in memory.
@MainActor final class NativeDictation {
    var onState: ((Bool) -> Void)?
    var onTranscript: ((String) -> Void)?
    var onError: ((String) -> Void)?
    var onPreparing: (() -> Void)?
    private(set) var active = false
    private var token: UUID?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var tapInstalled = false
    private var latest = ""
    private var limitTimer: Timer?
    private var finishTimer: Timer?

    func start(language: String) {
        guard token == nil else { return }
        let current = UUID(); token = current
        active = true; onPreparing?()
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] allowed in
            DispatchQueue.main.async {
                guard let self, self.token == current else { return }
                guard allowed else { self.fail("Разрешите микрофон для CodexBridge Companions в настройках macOS."); return }
                SFSpeechRecognizer.requestAuthorization { status in
                    DispatchQueue.main.async {
                        guard self.token == current else { return }
                        guard status == .authorized else {
                            self.fail("Разрешите распознавание речи для CodexBridge Companions в настройках macOS."); return
                        }
                        self.begin(language: language, token: current)
                    }
                }
            }
        }
    }

    private func begin(language: String, token current: UUID) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)), recognizer.isAvailable else {
            fail("Системное распознавание речи сейчас недоступно для языка \(language)."); return
        }
        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail("Не найден доступный микрофон. Проверьте устройство ввода macOS."); return
        }
        self.engine = engine; self.request = request; self.recognizer = recognizer
        do { try installInputTap(input, request: request, format: format) }
        catch { fail("Не удалось подключить микрофон. Проверьте устройство ввода macOS."); return }
        tapInstalled = true
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.token == current else { return }
                if let result { self.latest = result.bestTranscription.formattedString }
                if result?.isFinal == true { self.complete(deliver: true) }
                else if error != nil {
                    // Finishing a recording can produce an error after a usable partial result.
                    if self.finishTimer != nil { self.complete(deliver: true) }
                    else { self.fail("Не удалось распознать речь. Проверьте микрофон и повторите запись.") }
                }
            }
        }
        do { engine.prepare(); try engine.start() }
        catch { fail("Не удалось запустить микрофон: \(error.localizedDescription)"); return }
        onState?(true)
        let limit = Timer(timeInterval: 60, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.finish() }
        }
        limitTimer = limit; RunLoop.main.add(limit, forMode: .common)
    }

    /// End audio immediately, then allow a short bounded time for the final recognition result.
    func finish() {
        guard token != nil else { return }
        guard request != nil else { complete(deliver: false); return }
        guard finishTimer == nil else { return }
        stopAudio(); request?.endAudio(); task?.finish()
        let deadline = Timer(timeInterval: 2, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.complete(deliver: true) }
        }
        finishTimer = deadline; RunLoop.main.add(deadline, forMode: .common)
    }

    func cancel() { complete(deliver: false) }

    private func installInputTap(_ input: AVAudioInputNode, request: SFSpeechAudioBufferRecognitionRequest, format: AVAudioFormat) throws {
#if compiler(>=6.4)
        if #available(macOS 27.0, *) {
            try input.__installTap(onBus: 0, bufferSize: 1024, format: format, error: ()) { buffer, _ in request.append(buffer) }
        } else {
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        }
#else
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
#endif
    }

    private func stopAudio() {
        limitTimer?.invalidate(); limitTimer = nil
        engine?.stop()
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }
    }

    private func complete(deliver: Bool) {
        guard token != nil else { return }
        token = nil
        stopAudio(); finishTimer?.invalidate(); finishTimer = nil
        request?.endAudio(); task?.cancel()
        task = nil; request = nil; engine = nil; recognizer = nil
        let transcript = latest.trimmingCharacters(in: .whitespacesAndNewlines); latest = ""
        active = false; onState?(false)
        if deliver, !transcript.isEmpty { onTranscript?(transcript) }
    }

    private func fail(_ message: String) { complete(deliver: false); onError?(message) }
}
