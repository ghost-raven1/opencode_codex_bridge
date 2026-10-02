import AppKit
import AVFoundation

@main struct NativeSpeechTests {
    @MainActor static func main() {
        let candidates = [
            SystemVoiceCandidate(identifier: "male", language: "ru-RU", female: false, quality: 3),
            SystemVoiceCandidate(identifier: "compact", language: "ru-RU", female: true, quality: 1),
            SystemVoiceCandidate(identifier: "enhanced", language: "ru-RU", female: true, quality: 2),
            SystemVoiceCandidate(identifier: "other-language", language: "en-US", female: true, quality: 3),
        ]
        precondition(SystemSpeechProfile.preferredVoice(language: "ru-RU", voices: candidates) == "enhanced")
        precondition(SystemSpeechProfile.preferredVoice(language: "ru_RU", voices: candidates.reversed()) == "enhanced")
        precondition(SystemSpeechProfile.preferredVoice(language: "ru-KZ", voices: candidates) == "enhanced")
        precondition(SystemSpeechProfile.preferredVoice(language: "ja-JP", voices: candidates) == nil)
        let neutral = SystemSpeechProfile.utterance(text: "Проверка профиля без воспроизведения.", voice: nil)
        precondition(neutral.pitchMultiplier == 1)
        precondition(neutral.rate == AVSpeechUtteranceDefaultSpeechRate)

        let installed = AVSpeechSynthesisVoice.speechVoices()
        let speech = NativeSpeech()
        speech.selectVoice(identifier: nil, language: "ru-RU")
        if installed.contains(where: { $0.language == "ru-RU" && $0.gender == .female }) {
            precondition(speech.voice?.language == "ru-RU" && speech.voice?.gender == .female)
        }
        if let explicit = installed.first(where: { $0.language != "ru-RU" }) ?? installed.first {
            speech.selectVoice(identifier: explicit.identifier, language: "ru-RU")
            precondition(speech.voice?.identifier == explicit.identifier, "An explicit user voice must override automatic selection")
            let selected = SystemSpeechProfile.utterance(text: "Explicit voice", voice: speech.voice)
            precondition(selected.voice?.identifier == explicit.identifier)
            precondition(selected.pitchMultiplier == neutral.pitchMultiplier && selected.rate == neutral.rate)
        }
        let previous = speech.synthesizer, identifier = speech.voice?.identifier
        speech.setMuted(true); speech.suspended = true; speech.resetSynthesizer()
        precondition(previous !== speech.synthesizer && speech.voice?.identifier == identifier)
        precondition(speech.muted && speech.suspended && speech.playbackPhase == nil, "Reset changed user controls or started old speech")
        print("PASS neutral system speech profile, deterministic female/language selection, explicit override and reset preserving controls; no audio played")
    }
}
