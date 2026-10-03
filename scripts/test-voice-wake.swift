import AppKit

/// Recognition fixture exercises the real mode handoff without permission dialogs or microphone audio.
@MainActor final class FakeSpeechCapture: SpeechCapture {
    var onStarted: (() -> Void)?, onResult: ((CapturedSpeech) -> Void)?, onError: ((String) -> Void)?
    var starts = 0, stops = 0, renewals = 0, finishes = 0
    var ready = true
    func start(language: String) { starts += 1; if ready { onStarted?() } }
    func renewRecognition() { renewals += 1 }
    func finish() { finishes += 1 }
    func stop() { stops += 1 }
    func result(_ text: String, final: Bool = false, pauseAt: Int? = nil) {
        let source = text as NSString
        var offset = 0, time = 0.0
        let segments = text.components(separatedBy: " ").enumerated().map { index, word -> VoiceSegment in
            let range = source.range(of: word, range: NSRange(location: offset, length: source.length - offset))
            offset = NSMaxRange(range); time += index == pauseAt ? 1 : 0.05
            let segment = VoiceSegment(range: range, timestamp: time, duration: 0.25); time += 0.25
            return segment
        }
        onResult?(CapturedSpeech(text: text, segments: segments, final: final))
    }
}

@main struct WakeTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        for keyword in ["opencode", "OpenCode", "OPEN CODE", "опенкод", "Опен код", "оупенкод", "оупен код", "open-code", "опен коуд"] {
            precondition(WakeWord.recognize(" \(keyword): проверь 🎙", segments: [])?.text == "проверь 🎙", "Missing keyword: \(keyword)")
        }
        for text in ["не opencode", "Исправь opencode", "OpenCoder", "opencode123", "open", "code", "слово опенкод", "🗣 OpenCode"] {
            precondition(WakeWord.recognize(text, segments: []) == nil, "Unexpected wake: \(text)")
        }
        let capture = FakeSpeechCapture(), dictation = NativeDictation(capture: capture)
        var texts: [String] = [], commands: [VoiceInput] = [], wakes = 0, states: [Bool] = []
        dictation.onTranscript = { texts.append($0) }; dictation.onCommand = { commands.append($0) }
        dictation.onWake = { wakes += 1 }; dictation.onState = { states.append($0) }
        dictation.listen(language: "ru-RU")
        precondition(dictation.listening && !dictation.active && capture.starts == 1)
        capture.result("фоновая беседа", final: true)
        precondition(capture.renewals == 1 && texts.isEmpty && commands.isEmpty && states.isEmpty)
        capture.result("OpenCode проверь 🎙")
        precondition(wakes == 1 && dictation.active && !dictation.listening && capture.starts == 1,
            "Wake restarted the microphone or lost the same-utterance draft")
        capture.result("Опен код проверь 🎙. Отправить", final: true, pauseAt: 4)
        precondition(commands == [VoiceInput(text: "проверь 🎙.", command: "submit")] && texts.isEmpty)
        precondition(states == [true, false] && !dictation.active)
        dictation.listen(language: "ru-RU"); capture.result("OpenCode")
        capture.result("Проверь тесты. Отправить", final: true, pauseAt: 2)
        precondition(commands.last == VoiceInput(text: "Проверь тесты.", command: "submit"),
            "Post-wake transcription without its earlier keyword was discarded")
        dictation.listen(language: "ru-RU"); capture.result("OpenCode")
        capture.result("Проверь отдельный сценарий"); capture.result("Отправить", final: true)
        precondition(commands.last == VoiceInput(text: "Проверь отдельный сценарий", command: "submit"),
            "A standalone send replaced the request with an empty draft")

        // A final keyword alone still opens an empty draft, ready for a following utterance.
        dictation.listen(language: "ru-RU"); capture.result("OpenCode", final: true)
        precondition(dictation.active && capture.renewals == 2)
        capture.result("Проверь тесты", final: true)
        precondition(texts == ["Проверь тесты"] && commands.count == 3, "Draft was automatically submitted")

        dictation.listen(language: "ru-RU"); capture.result("OpenCode. Не отправить", final: true, pauseAt: 2)
        precondition(texts.last == "Не отправить" && commands.count == 3, "Negation became a send command")
        dictation.listen(language: "ru-RU"); capture.result("OpenCode Отменить диктовку", final: true)
        precondition(commands.last == VoiceInput(text: "", command: "cancel"))
        dictation.listen(language: "ru-RU"); capture.result("OpenCode отправить")
        let sent = commands.count
        capture.result("Не opencode отправить", final: true)
        precondition(commands.count == sent, "A recognizer revision sent an obsolete command")
        dictation.listen(language: "ru-RU"); capture.result("OpenCode")
        capture.result("Не"); capture.result("Отправить", final: true)
        precondition(commands.count == sent && texts.last == "Не Отправить", "Separate ASR packets bypassed negation")
        dictation.listen(language: "ru-RU"); capture.result("OpenCode")
        capture.result("Проверь ввод"); capture.result("Отправить"); capture.result("Отправить письмо", final: true)
        precondition(commands.count == sent && texts.last == "Проверь ввод Отправить письмо",
            "A revised command either sent early or lost the prior draft")

        // Late callbacks from a previous capture cannot wake, deliver or affect its replacement.
        dictation.listen(language: "ru-RU")
        let late = capture.onResult, lateStarted = capture.onStarted
        dictation.stopListening(); dictation.listen(language: "ru-RU")
        let count = wakes
        late?(CapturedSpeech(text: "OpenCode отправить", segments: [], final: true)); lateStarted?()
        precondition(!dictation.active && wakes == count)
        dictation.start(language: "ru-RU"); capture.result("OpenCode обычное слово", final: true)
        precondition(texts.last == "OpenCode обычное слово", "Manual dictation removed a literal keyword")
        dictation.start(language: "ru-RU"); capture.result("Сохранённый черновик")
        dictation.finish(); capture.onError?("fixture finish error")
        precondition(texts.last == "Сохранённый черновик" && !dictation.active && capture.finishes == 1,
            "Finishing lost a usable partial result")
        dictation.listen(language: "ru-RU"); capture.result("OpenCode отправить")
        let beforeCancel = commands.count
        dictation.cancel(); RunLoop.main.run(until: Date().addingTimeInterval(1.1))
        precondition(commands.count == beforeCancel, "Cancel did not invalidate a pending send timer")

        capture.ready = false
        dictation.start(language: "ru-RU"); let permissionDone = capture.onStarted
        dictation.cancel(); permissionDone?()
        precondition(!dictation.active && !dictation.recording, "Canceled permission request reopened the microphone")
        capture.ready = true

        let suite = "dev.codexbridge.wake-tests.\(UUID())", defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let controller = WakeControl(dictation: dictation, defaults: defaults)
        var microphoneAllowed = true, outputSpeaking = false
        let sync = { controller.update(allowed: microphoneAllowed, dictating: dictation.active, speaking: outputSpeaking) }
        controller.onChange = sync
        dictation.onListening = { _ in controller.captureChanged() }
        dictation.onPreparing = sync
        dictation.onState = { _ in sync() }
        dictation.onWakeError = { _ in controller.captureFailed() }
        controller.configure(configured: false, allowed: true, language: "ru-RU")
        precondition(controller.menuItem.state == .off && !dictation.listening)
        controller.setEnabled(true); precondition(dictation.listening && defaults.bool(forKey: "companions.wakeWordEnabled"))
        outputSpeaking = true; sync()
        precondition(!dictation.recording, "Our own TTS left keyword capture running")
        outputSpeaking = false; sync()
        precondition(!dictation.listening, "Speaker tail bypassed the resume cooldown")
        RunLoop.main.run(until: Date().addingTimeInterval(0.9))
        precondition(dictation.listening)
        capture.result("OpenCode"); controller.setEnabled(false)
        precondition(dictation.active, "Turning off background listening canceled a foreground draft")
        dictation.cancel(); controller.setEnabled(true)
        microphoneAllowed = false; controller.disableMicrophone(); sync()
        precondition(!dictation.recording && !defaults.bool(forKey: "companions.wakeWordEnabled"))
        microphoneAllowed = true; sync()
        precondition(!dictation.recording, "Re-enabling dictation reopened background capture automatically")
        controller.setEnabled(true); capture.onError?("fixture denied")
        precondition(controller.status["state"] as? String == "unavailable" && !dictation.recording)
        controller.setEnabled(true); precondition(dictation.listening, "Explicit retry did not recover")
        controller.stop(); controller.update(allowed: true, dictating: false, speaking: false)
        RunLoop.main.run(until: Date().addingTimeInterval(0.9))
        precondition(!dictation.recording, "Shutdown reopened the microphone")
        print("PASS keyword variants, continuous handoff, wake stripping, explicit submit, passive discard, rotation, cancellation, late callbacks, manual literal keyword, persisted opt-in, own speech pause, retry, global disable and shutdown")
    }
}
