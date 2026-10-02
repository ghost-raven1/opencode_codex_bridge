import AppKit
import AVFoundation

struct SystemVoiceCandidate {
    let identifier: String
    let language: String
    let female: Bool
    let quality: Int
}

/// Prefer an installed female voice in the requested language; selection never depends on the task role.
enum SystemSpeechProfile {
    static func preferredVoice(language: String, voices: [SystemVoiceCandidate]) -> String? {
        let requested = language.replacingOccurrences(of: "_", with: "-").lowercased()
        let family = requested.split(separator: "-").first
        return voices.filter { $0.language.lowercased().split(separator: "-").first == family }.sorted { left, right in
            if left.female != right.female { return left.female }
            let leftExact = left.language.lowercased() == requested, rightExact = right.language.lowercased() == requested
            if leftExact != rightExact { return leftExact }
            if left.quality != right.quality { return left.quality > right.quality }
            return left.identifier < right.identifier
        }.first?.identifier
    }

    static func utterance(text: String, voice: AVSpeechSynthesisVoice?) -> AVSpeechUtterance {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.pitchMultiplier = 1
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        return utterance
    }
}

/// One playback queue for system speech and locally generated audio; mouth motion follows real playback.
@MainActor final class NativeSpeech: NSObject, @preconcurrency AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    private struct Entry {
        let characterId: String
        let text: String
        var path: String? = nil
        var audioId: String? = nil
        var streaming = false
    }
    private(set) var synthesizer = AVSpeechSynthesizer()
    var voice: AVSpeechSynthesisVoice?
    var onEvent: ((String, String, NSRange?) -> Void)?
    var onStarted: ((String, String) -> Void)?
    var onReset: (() -> Void)?
    var onDrained: (() -> Void)?
    var onAmplitude: ((Bool) -> Void)?
    var onLevel: ((Double) -> Void)?
    var onAudioFinished: ((String, String) -> Void)?
    var onAudioStarted: ((String) -> Void)?
    var onChunkAccepted: ((String, Int) -> Void)?
    var onChunkConsumed: ((String, Int) -> Void)?
    var onBuffering: ((String, Bool, Double) -> Void)?
    var makeStream: () -> NativeAudioStream = { NativeAudioStream() }
    private var active: AVSpeechUtterance?
    private var player: AVAudioPlayer?
    private var stream: NativeAudioStream?
    private var knownStreams = Set<String>()
    private var meter: Timer?
    private var current: Entry?
    private var started = false
    private var queue: [Entry] = []
    private(set) var muted = false
    var suspended = false { didSet { if suspended { stop() } } }
    var playbackPhase: String? {
        current.map { entry in
            if stream?.buffering == true { return "buffering" }
            return started ? (entry.path == nil && !entry.streaming ? "system" : "local") : "queued"
        }
    }

    override init() { super.init(); synthesizer.delegate = self }

    /// Replace an unresponsive speech service after the router cancels its old utterance.
    func resetSynthesizer() {
        guard current == nil else { return }
        synthesizer.delegate = nil; synthesizer.stopSpeaking(at: .immediate)
        synthesizer = AVSpeechSynthesizer(); synthesizer.delegate = self
    }

    func selectVoice(identifier: String?, language: String) {
        let preferred = SystemSpeechProfile.preferredVoice(language: language, voices: AVSpeechSynthesisVoice.speechVoices().map {
            SystemVoiceCandidate(identifier: $0.identifier, language: $0.language, female: $0.gender == .female, quality: $0.quality.rawValue)
        })
        voice = identifier.flatMap { AVSpeechSynthesisVoice(identifier: $0) }
            ?? preferred.flatMap { AVSpeechSynthesisVoice(identifier: $0) }
            ?? AVSpeechSynthesisVoice(language: language)
    }

    func enqueue(characterId: String, text: String, role _: String = "coordinator", audioId: String? = nil) {
        guard !muted, !suspended, !text.isEmpty, queue.count < 16 else {
            if let audioId { onAudioFinished?(audioId, "cancel") }; return
        }
        queue.append(Entry(characterId: characterId, text: String(text.prefix(8000)), audioId: audioId)); speakNext()
    }

    func enqueueAudio(characterId: String, text: String, role _: String, path: String, audioId: String) {
        guard !muted, !suspended, queue.count < 16 else { onAudioFinished?(audioId, "cancel"); return }
        queue.append(Entry(characterId: characterId, text: text, path: path, audioId: audioId)); speakNext()
    }

    /// Only the router's active stream is admitted; future streams remain in the TypeScript queue.
    func startStream(characterId: String, text: String, audioId: String) {
        guard knownStreams.insert(audioId).inserted else { return }
        guard !muted, !suspended, current == nil, queue.isEmpty else { onAudioFinished?(audioId, "cancel"); return }
        let output = makeStream()
        current = Entry(characterId: characterId, text: String(text.prefix(8000)), audioId: audioId, streaming: true)
        stream = output; started = false
        output.onAccepted = { [weak self, weak output] index in
            guard let self, self.stream === output else { return }; self.onChunkAccepted?(audioId, index)
        }
        output.onConsumed = { [weak self, weak output] index in
            guard let self, self.stream === output else { return }; self.onChunkConsumed?(audioId, index)
        }
        output.onStarted = { [weak self, weak output] in
            guard let self, self.stream === output else { return }
            self.started = true; self.onAudioStarted?(audioId)
            guard self.stream === output else { return }
            self.onEvent?("start", characterId, nil)
            if self.stream === output { self.onStarted?(characterId, text) }
        }
        output.onLevel = { [weak self, weak output] level in
            guard let self, self.stream === output else { return }
            self.onLevel?(level); self.onAmplitude?(level > 0.2)
        }
        output.onBuffering = { [weak self, weak output] buffering, seconds in
            guard let self, self.stream === output else { return }; self.onBuffering?(audioId, buffering, seconds)
        }
        output.onFinished = { [weak self, weak output] phase in
            guard let self, self.stream === output else { return }; self.complete(phase: phase)
        }
    }

    func appendStream(audioId: String, index: Int, path: String, duration: Double, sampleRate: Double) {
        guard current?.audioId == audioId else { return }
        stream?.append(index: index, path: path, duration: duration, sampleRate: sampleRate)
    }

    func endStream(audioId: String, chunks: Int) { if current?.audioId == audioId { stream?.end(chunks: chunks) } }
    func playStream(audioId: String) { if current?.audioId == audioId { stream?.forcePlay() } }

    func stop(characterId id: String? = nil) {
        let removed = queue.filter { id == nil || $0.characterId == id }
        queue.removeAll { id == nil || $0.characterId == id }
        var cancelled: Entry?
        if let entry = current, id == nil || entry.characterId == id {
            let cancelledStream = stream; stream = nil
            active = nil; current = nil; started = false
            cancelledStream?.cancel()
            synthesizer.stopSpeaking(at: .immediate)
            player?.stop(); player = nil; meter?.invalidate(); meter = nil
            cancelled = entry
        }
        if let entry = cancelled {
            onReset?(); onEvent?("cancel", entry.characterId, nil)
            if let audioId = entry.audioId { onAudioFinished?(audioId, "cancel") }
        }
        for entry in removed { if let audioId = entry.audioId { onAudioFinished?(audioId, "cancel") } }
        speakNext()
    }

    func setMuted(_ value: Bool) { muted = value; if muted { stop() } }

    private func speakNext() {
        guard current == nil, !queue.isEmpty, !muted, !suspended else { return }
        let entry = queue.removeFirst()
        current = entry; started = false
        if let path = entry.path {
            do {
                let audio = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: path))
                audio.delegate = self; audio.isMeteringEnabled = true; player = audio
                guard audio.play() else { complete(phase: "error"); return }
                started = true
                if let audioId = entry.audioId { onAudioStarted?(audioId) }
                onEvent?("start", entry.characterId, nil); onStarted?(entry.characterId, entry.text)
                meter = Timer.scheduledTimer(withTimeInterval: 1.0 / 24, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard let self, let player = self.player else { return }
                        player.updateMeters()
                        let power = player.averagePower(forChannel: 0)
                        self.onAmplitude?(player.isPlaying && power > -38)
                        self.onLevel?(player.isPlaying ? min(1, max(0, Double(power + 45) / 35)) : 0)
                    }
                }
            } catch { complete(phase: "error") }
        } else {
            let utterance = SystemSpeechProfile.utterance(text: entry.text, voice: voice)
            active = utterance; synthesizer.speak(utterance)
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        guard active === utterance, let entry = current else { return }
        started = true
        if let audioId = entry.audioId { onAudioStarted?(audioId) }
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
        stream = nil; active = nil; current = nil; started = false; player = nil; meter?.invalidate(); meter = nil
        onReset?(); onEvent?(phase, entry.characterId, nil)
        if let audioId = entry.audioId { onAudioFinished?(audioId, phase) }
        if current == nil, queue.isEmpty { onDrained?() } else { speakNext() }
    }
}
