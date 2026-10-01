import AppKit
import AVFoundation

/// One playback queue for system speech and locally generated audio; mouth motion follows real playback.
@MainActor final class NativeSpeech: NSObject, @preconcurrency AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    private struct Entry {
        let characterId: String
        let text: String
        let role: String
        var path: String? = nil
        var audioId: String? = nil
    }
    let synthesizer = AVSpeechSynthesizer()
    var voice: AVSpeechSynthesisVoice?
    var onEvent: ((String, String, NSRange?) -> Void)?
    var onStarted: ((String, String) -> Void)?
    var onReset: (() -> Void)?
    var onDrained: (() -> Void)?
    var onAmplitude: ((Bool) -> Void)?
    var onAudioFinished: ((String, String) -> Void)?
    private var active: AVSpeechUtterance?
    private var player: AVAudioPlayer?
    private var meter: Timer?
    private var current: Entry?
    private var queue: [Entry] = []
    private(set) var muted = false
    var suspended = false

    override init() { super.init(); synthesizer.delegate = self }

    func selectVoice(identifier: String?, language: String) {
        voice = identifier.flatMap { AVSpeechSynthesisVoice(identifier: $0) }
            ?? AVSpeechSynthesisVoice(language: language)
    }

    func enqueue(characterId: String, text: String, role: String = "coordinator", audioId: String? = nil) {
        guard !muted, !suspended, !text.isEmpty, queue.count < 16 else {
            if let audioId { onAudioFinished?(audioId, "cancel") }; return
        }
        queue.append(Entry(characterId: characterId, text: String(text.prefix(8000)), role: role, audioId: audioId)); speakNext()
    }

    func enqueueAudio(characterId: String, text: String, role: String, path: String, audioId: String) {
        guard !muted, !suspended, queue.count < 16 else { onAudioFinished?(audioId, "cancel"); return }
        queue.append(Entry(characterId: characterId, text: text, role: role, path: path, audioId: audioId)); speakNext()
    }

    func stop(characterId id: String? = nil) {
        let removed = queue.filter { id == nil || $0.characterId == id }
        queue.removeAll { id == nil || $0.characterId == id }
        for entry in removed { if let audioId = entry.audioId { onAudioFinished?(audioId, "cancel") } }
        if let entry = current, id == nil || entry.characterId == id {
            active = nil; current = nil
            synthesizer.stopSpeaking(at: .immediate)
            player?.stop(); player = nil; meter?.invalidate(); meter = nil
            onEvent?("cancel", entry.characterId, nil); onReset?()
            if let audioId = entry.audioId { onAudioFinished?(audioId, "cancel") }
        }
        speakNext()
    }

    func setMuted(_ value: Bool) { muted = value; if muted { stop() } }

    private func speakNext() {
        guard current == nil, !queue.isEmpty, !muted, !suspended else { return }
        let entry = queue.removeFirst()
        current = entry
        if let path = entry.path {
            do {
                let audio = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: path))
                audio.delegate = self; audio.isMeteringEnabled = true; player = audio
                guard audio.play() else { complete(phase: "error"); return }
                onEvent?("start", entry.characterId, nil); onStarted?(entry.characterId, entry.text)
                meter = Timer.scheduledTimer(withTimeInterval: 1.0 / 24, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard let self, let player = self.player else { return }
                        player.updateMeters()
                        self.onAmplitude?(player.isPlaying && player.averagePower(forChannel: 0) > -38)
                    }
                }
            } catch { complete(phase: "error") }
        } else {
            let utterance = AVSpeechUtterance(string: entry.text)
            utterance.voice = voice
            // Distinct fallback delivery when only one Russian system voice is installed.
            let profiles: [String: (Float, Float)] = ["coordinator": (1.0, 0.5), "developer": (1.12, 0.53),
                "researcher": (0.96, 0.46), "reviewer": (0.88, 0.49)]
            let profile = profiles[entry.role] ?? (1.0, 0.5)
            utterance.pitchMultiplier = profile.0; utterance.rate = profile.1
            active = utterance; synthesizer.speak(utterance)
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        guard active === utterance, let entry = current else { return }
        onEvent?("start", entry.characterId, nil); onStarted?(entry.characterId, utterance.speechString)
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString range: NSRange, utterance: AVSpeechUtterance) {
        guard active === utterance, let entry = current else { return }
        onEvent?("word", entry.characterId, range)
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        if active === utterance { complete(phase: "end") }
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        if active === utterance { complete(phase: "cancel") }
    }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        if self.player === player { complete(phase: flag ? "end" : "error") }
    }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        if self.player === player { complete(phase: "error") }
    }
    private func complete(phase: String) {
        guard let entry = current else { return }
        active = nil; current = nil; player = nil; meter?.invalidate(); meter = nil
        onEvent?(phase, entry.characterId, nil); onReset?()
        if let audioId = entry.audioId { onAudioFinished?(audioId, phase) }
        if queue.isEmpty { onDrained?() } else { speakNext() }
    }
}
