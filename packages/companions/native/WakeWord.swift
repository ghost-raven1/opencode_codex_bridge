import Foundation

struct WakeTranscript {
    let text: String
    let segments: [VoiceSegment]
}

/// Only an utterance prefix wakes dictation; mentions inside ordinary conversation are ignored.
enum WakeWord {
    static let hints = ["OpenCode", "open code", "опенкод", "опен код", "оупенкод", "оупен код"]
    private static let prefix = try! NSRegularExpression(
        pattern: #"^\s*(?:open[\s-]*code|[оo]упен[\s-]*к[оo](?:д|уд)|[оo]пен[\s-]*к[оo](?:д|уд))(?=$|[^\p{L}\p{N}])"#,
        options: [.caseInsensitive])

    /// Keep UTF-16 word ranges aligned after removing the keyword, including recognizer revisions.
    static func recognize(_ text: String, segments: [VoiceSegment]) -> WakeTranscript? {
        let source = text as NSString
        guard let match = prefix.firstMatch(in: text, range: NSRange(location: 0, length: source.length)) else { return nil }
        var offset = NSMaxRange(match.range)
        let separator = CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters)
        while offset < source.length, let scalar = UnicodeScalar(source.character(at: offset)), separator.contains(scalar) { offset += 1 }
        let remaining = source.substring(from: offset)
        let adjusted = segments.compactMap { segment -> VoiceSegment? in
            guard segment.range.location >= offset, segment.range.length >= 0,
                  segment.range.location <= source.length, segment.range.length <= source.length - segment.range.location else { return nil }
            return VoiceSegment(range: NSRange(location: segment.range.location - offset, length: segment.range.length),
                timestamp: segment.timestamp, duration: segment.duration)
        }
        return WakeTranscript(text: remaining, segments: adjusted)
    }
}
