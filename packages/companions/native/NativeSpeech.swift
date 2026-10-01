import AppKit
import AVFoundation

/// Serial system speech with callbacks that drive the visible character, never text timing guesses.
@MainActor final class NativeSpeech: NSObject, @preconcurrency AVSpeechSynthesizerDelegate {
    let synthesizer = AVSpeechSynthesizer()
    var voice: AVSpeechSynthesisVoice?
    var onEvent: ((String, String, NSRange?) -> Void)?
    var onStarted: ((String, String) -> Void)?
    var onReset: (() -> Void)?
    var onDrained: (() -> Void)?
    private var active: AVSpeechUtterance?
    private var characterId: String?
    private var queue: [(String, String)] = []
    private(set) var muted = false
    var suspended = false

    override init() { super.init(); synthesizer.delegate = self }

    func selectVoice(identifier: String?, language: String) {
        voice = identifier.flatMap { AVSpeechSynthesisVoice(identifier: $0) }
            ?? AVSpeechSynthesisVoice(language: language)
    }

    func enqueue(characterId: String, text: String) {
        guard !muted, !suspended, !text.isEmpty, queue.count < 16 else { return }
        queue.append((characterId, String(text.prefix(8000)))); speakNext()
    }

    func stop(characterId id: String? = nil) {
        if let id { queue.removeAll { $0.0 == id } } else { queue.removeAll() }
        if active != nil, id == nil || characterId == id {
            let previous = characterId
            active = nil; characterId = nil
            synthesizer.stopSpeaking(at: .immediate)
            if let previous { onEvent?("cancel", previous, nil) }
            onReset?()
        }
        speakNext()
    }

    func setMuted(_ value: Bool) {
        muted = value
        if muted { stop() }
    }

    private func speakNext() {
        guard active == nil, !queue.isEmpty, !muted, !suspended else { return }
        let (id, text) = queue.removeFirst()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        active = utterance; characterId = id
        synthesizer.speak(utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        guard active === utterance, let id = characterId else { return }
        onEvent?("start", id, nil); onStarted?(id, utterance.speechString)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString range: NSRange, utterance: AVSpeechUtterance) {
        guard active === utterance, let id = characterId else { return }
        onEvent?("word", id, range)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        complete(utterance, phase: "end")
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        complete(utterance, phase: "cancel")
    }

    private func complete(_ utterance: AVSpeechUtterance, phase: String) {
        guard active === utterance, let id = characterId else { return }
        active = nil; characterId = nil
        onEvent?(phase, id, nil); onReset?()
        if queue.isEmpty { onDrained?() } else { speakNext() }
    }
}
