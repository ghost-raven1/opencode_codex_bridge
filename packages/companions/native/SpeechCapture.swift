import AppKit
import AVFoundation
import Speech

struct CapturedSpeech {
    let text: String
    let segments: [VoiceSegment]
    let final: Bool
}

/// One capture can change from keyword listening to dictation without dropping microphone audio.
@MainActor protocol SpeechCapture: AnyObject {
    var onStarted: (() -> Void)? { get set }
    var onResult: ((CapturedSpeech) -> Void)? { get set }
    var onError: ((String) -> Void)? { get set }
    func start(language: String)
    func renewRecognition()
    func finish()
    func stop()
}

/// Serializes request replacement with the audio tap; neither mode writes audio to disk.
private final class SpeechBufferSink {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    func replace(_ request: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock(); self.request = request; lock.unlock()
    }
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }; request?.append(buffer)
    }
}

/// System permission and recognizer lifetime are separate from voice-command and wake-word policy.
@MainActor final class NativeSpeechCapture: SpeechCapture {
    var onStarted: (() -> Void)?
    var onResult: ((CapturedSpeech) -> Void)?
    var onError: ((String) -> Void)?
    private let sink = SpeechBufferSink()
    private var token: UUID?, recognition: UUID?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var tapInstalled = false
    private var configurationObserver: NSObjectProtocol?

    func start(language: String) {
        guard token == nil else { return }
        let current = UUID(); token = current
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined || SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            NSApp.activate(ignoringOtherApps: true)
        }
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] allowed in
            DispatchQueue.main.async {
                guard let self, self.token == current else { return }
                guard allowed else { self.fail("Разрешите микрофон для CodexBridge Companions в настройках macOS."); return }
                SFSpeechRecognizer.requestAuthorization { status in
                    DispatchQueue.main.async {
                        guard self.token == current else { return }
                        guard status == .authorized else { self.fail("Разрешите распознавание речи для CodexBridge Companions в настройках macOS."); return }
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
        let engine = AVAudioEngine(), input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { fail("Не найден доступный микрофон. Проверьте устройство ввода macOS."); return }
        self.engine = engine; self.recognizer = recognizer
        renewRecognition()
        do {
            let sink = self.sink
            try MicrophoneTap.install(on: input, format: format) { buffer, _ in sink.append(buffer) }
            tapInstalled = true; engine.prepare(); try engine.start()
        } catch { fail("Не удалось запустить микрофон: \(error.localizedDescription)"); return }
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.token == current else { return }
                self.fail("Аудиоустройство изменилось. Включи прослушивание или диктовку повторно.")
            }
        }
        onStarted?()
    }

    /// Refresh bounded recognition sessions while retaining the same running microphone engine.
    func renewRecognition() {
        guard token != nil, let recognizer else { return }
        recognition = nil; sink.replace(nil); request?.endAudio(); task?.cancel()
        let request = SFSpeechAudioBufferRecognitionRequest(), current = UUID()
        request.shouldReportPartialResults = true; request.contextualStrings = WakeWord.hints
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request; recognition = current; sink.replace(request)
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.recognition == current else { return }
                if let result {
                    self.onResult?(CapturedSpeech(text: result.bestTranscription.formattedString,
                        segments: result.bestTranscription.segments.map {
                            VoiceSegment(range: $0.substringRange, timestamp: $0.timestamp, duration: $0.duration)
                        }, final: result.isFinal))
                }
                if error != nil, result?.isFinal != true, self.recognition == current {
                    self.fail("Не удалось распознать речь. Проверьте микрофон и повторите запись.")
                }
            }
        }
    }

    func finish() { stopAudio(); sink.replace(nil); request?.endAudio(); task?.finish() }
    func stop() {
        token = nil; recognition = nil; sink.replace(nil); stopAudio()
        request?.endAudio(); task?.cancel(); task = nil; request = nil; recognizer = nil; engine = nil
    }
    private func stopAudio() {
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver); self.configurationObserver = nil }
        engine?.stop()
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }
    }
    private func fail(_ message: String) { stop(); onError?(message) }
}
