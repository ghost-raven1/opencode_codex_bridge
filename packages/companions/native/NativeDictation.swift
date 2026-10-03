import AVFoundation
import Speech

/// Passive recognition never delivers text; only a user action or a keyword starts a bounded draft.
@MainActor final class NativeDictation {
    var onState: ((Bool) -> Void)?
    var onTranscript: ((String) -> Void)?
    var onCommand: ((VoiceInput) -> Void)?
    var onError: ((String) -> Void)?
    var onPreparing: (() -> Void)?
    var onListening: ((Bool) -> Void)?
    var onWake: (() -> Void)?
    var onWakeError: ((String) -> Void)?
    private(set) var active = false
    private(set) var recording = false
    private var token: UUID?
    private var passive = false, woke = false
    private let capture: SpeechCapture
    private var latest = ""
    private var commandPrefix = ""
    private var segments: [VoiceSegment] = []
    private var recognitionResults = 0
    private var lastHasKeyword = false
    private var commandCandidate: VoiceInput?
    private var commandTimer: Timer?, limitTimer: Timer?, finishTimer: Timer?
    var listening: Bool { passive && recording }
    var preparingWake: Bool { passive && token != nil && !recording }

    init(capture: SpeechCapture? = nil) { self.capture = capture ?? NativeSpeechCapture() }

    func start(language: String) {
        guard !active else { return }
        // Mark the foreground mode before callbacks so background policy cannot reopen capture.
        clearCapture(); passive = false; active = true; woke = false
        onPreparing?(); begin(language: language)
    }

    func listen(language: String) {
        guard token == nil, !active else { return }
        passive = true; woke = false; begin(language: language)
    }

    func stopListening() {
        guard passive else { return }
        clearCapture(); passive = false; onListening?(false)
    }

    private func begin(language: String) {
        let current = UUID(); token = current
        recognitionResults = 0
        capture.onStarted = { [weak self] in
            guard let self, self.token == current else { return }
            self.recording = true
            if self.passive { self.renewDeadline(); self.onListening?(true) }
            else { self.dictationDeadline(); self.onState?(true) }
        }
        capture.onResult = { [weak self] result in
            guard let self, self.token == current else { return }
            self.receive(result)
        }
        capture.onError = { [weak self] message in
            guard let self, self.token == current else { return }
            if self.passive {
                self.clearCapture(); self.passive = false
                self.onWakeError?(message); self.onListening?(false)
            } else if self.finishTimer != nil { self.complete(deliver: true) }
            else { self.complete(deliver: false); self.onError?(message) }
        }
        capture.start(language: language)
    }

    private func receive(_ result: CapturedSpeech) {
        recognitionResults += 1; lastHasKeyword = WakeWord.recognize(result.text, segments: []) != nil
        if passive {
            guard let input = WakeWord.recognize(result.text, segments: result.segments) else {
                if result.final { capture.renewRecognition(); renewDeadline() }
                return
            }
            // The same recognition request retains audio and words following the keyword.
            passive = false; woke = true; active = true; updateTranscript(input.text, segments: input.segments)
            onPreparing?(); onListening?(false); onWake?(); dictationDeadline(); onState?(true)
        } else if woke {
            if let input = WakeWord.recognize(result.text, segments: result.segments) {
                updateTranscript(input.text, segments: input.segments)
            } else {
                // On-device recognition can start a new phrase without repeating its earlier keyword.
                updateTranscript(result.text, segments: result.segments)
            }
        } else { updateTranscript(result.text, segments: result.segments) }
        scheduleCommand()
        if result.final {
            if woke && latest.isEmpty { woke = false; capture.renewRecognition() }
            else { complete(deliver: true) }
        }
    }

    private var transcript: String { [commandPrefix, latest].filter { !$0.isEmpty }.joined(separator: " ") }

    /// A separately recognized Send must include the draft that preceded it in this capture.
    private func updateTranscript(_ text: String, segments: [VoiceSegment]) {
        if let input = VoiceCommands.recognize(text, segments: []), ["submit", "cancel"].contains(input.command),
           !latest.isEmpty, VoiceCommands.aliases[VoiceCommands.normalized(latest)] == nil {
            commandPrefix = transcript
        } else if !commandPrefix.isEmpty, text.hasPrefix(commandPrefix) { commandPrefix = "" }
        latest = text; self.segments = segments
    }

    private func recognizedCommand() -> VoiceInput? {
        guard let input = VoiceCommands.recognize(latest, segments: segments) else { return nil }
        guard input.text.isEmpty, !commandPrefix.isEmpty, ["submit", "cancel"].contains(input.command) else { return input }
        guard !VoiceCommands.blocksTerminalCommand(after: commandPrefix) else { return nil }
        return VoiceInput(text: input.command == "submit" ? commandPrefix : "", command: input.command)
    }

    private func renewDeadline() {
        limitTimer?.invalidate()
        let timer = Timer(timeInterval: 50, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.passive else { return }
                self.capture.renewRecognition(); self.renewDeadline()
            }
        }
        limitTimer = timer; RunLoop.main.add(timer, forMode: .common)
    }

    private func dictationDeadline() {
        limitTimer?.invalidate()
        let timer = Timer(timeInterval: 60, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.finish() }
        }
        limitTimer = timer; RunLoop.main.add(timer, forMode: .common)
    }

    /// Stop foreground audio now, allowing a bounded interval for its final recognition result.
    func finish() {
        guard active, token != nil, finishTimer == nil else { return }
        guard recording else { complete(deliver: false); return }
        limitTimer?.invalidate(); limitTimer = nil; recording = false
        let timer = Timer(timeInterval: 2, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.complete(deliver: true) }
        }
        finishTimer = timer; RunLoop.main.add(timer, forMode: .common); capture.finish()
    }

    func cancel() { if active { complete(deliver: false) } }

    /// Ordinary partials never send. Stable terminal commands keep the existing explicit-send rule.
    private func scheduleCommand() {
        let candidate = recognizedCommand()
        guard candidate != commandCandidate else { return }
        commandTimer?.invalidate(); commandTimer = nil; commandCandidate = candidate
        guard candidate != nil else { return }
        let deadline = Timer(timeInterval: 1, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.complete(deliver: true) }
        }
        commandTimer = deadline; RunLoop.main.add(deadline, forMode: .common)
    }

    /// Query permissions without opening the microphone; passive and foreground recording are distinct.
    func status(enabled: Bool, language: String) -> [String: Any] {
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language))
        let microphone: String
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: microphone = "authorized"
        case .denied: microphone = "denied"
        case .restricted: microphone = "restricted"
        case .notDetermined: microphone = "not-determined"
        @unknown default: microphone = "unknown"
        }
        let permission: String
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: permission = "authorized"
        case .denied: permission = "denied"
        case .restricted: permission = "restricted"
        case .notDetermined: permission = "not-determined"
        @unknown default: permission = "unknown"
        }
        return ["type": "dictation-status", "enabled": enabled, "active": active, "recording": recording,
                "wakeListening": listening, "language": language, "microphonePermission": microphone,
                "speechPermission": permission, "available": recognizer?.isAvailable ?? false,
                "onDeviceRecognition": recognizer?.supportsOnDeviceRecognition ?? false,
                "partialLength": (transcript as NSString).length, "recognitionResults": recognitionResults,
                "lastHasKeyword": lastHasKeyword, "segmentCount": segments.count,
                "maxWordPause": zip(segments.dropFirst(), segments).map { $0.timestamp - $1.timestamp - $1.duration }
                    .filter { $0.isFinite && $0 >= 0 }.max() ?? 0,
                "commandPending": commandCandidate != nil]
    }

    private func clearCapture() {
        token = nil; capture.stop(); recording = false
        for timer in [commandTimer, limitTimer, finishTimer] { timer?.invalidate() }
        commandTimer = nil; limitTimer = nil; finishTimer = nil
        latest = ""; commandPrefix = ""; segments = []; commandCandidate = nil
    }

    private func complete(deliver: Bool) {
        guard active, token != nil else { return }
        let transcript = self.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let command = recognizedCommand()
        clearCapture(); active = false; passive = false; woke = false; onState?(false)
        if deliver, let command { onCommand?(command) }
        else if deliver, !transcript.isEmpty { onTranscript?(transcript) }
    }
}
