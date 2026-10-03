import Foundation

/// Qwen has no word timestamps: distribute words over played PCM, never over synthesis time.
struct SpeechReveal {
    private let words: [(range: NSRange, end: Double)]
    private let units: Double
    private let length: Int
    private(set) var visible = 0
    private(set) var word: NSRange?

    init(text: String) {
        let value = text as NSString
        length = value.length
        let matches = try! NSRegularExpression(pattern: "\\S+").matches(in: text, range: NSRange(location: 0, length: value.length))
        var total = 0.0
        words = matches.map { match in
            let token = value.substring(with: match.range).lowercased()
            let vowels = token.filter { "аеёиоуыэюяaeiouy".contains($0) }.count
            total += max(1, Double(vowels)) + (token.last.map { ".!?…,:;".contains($0) } == true ? 0.8 : 0)
            return (match.range, total)
        }
        units = total
    }

    mutating func advance(elapsed: Double, duration: Double?, voiced: Bool) -> (Int, NSRange?) {
        guard elapsed.isFinite, elapsed >= 0, voiced, !words.isEmpty else { return (visible, word) }
        let seconds = duration.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? max(0.6, units / 4.8)
        let fraction = min(duration == nil ? 0.94 : 1, max(0, elapsed / seconds))
        var previous = 0.0
        for entry in words {
            if previous > fraction * units { break }
            if duration == nil, words.count > 1, entry.range == words.last?.range { break }
            if NSMaxRange(entry.range) > visible { visible = NSMaxRange(entry.range); word = entry.range }
            previous = entry.end
        }
        return (min(length, visible), word)
    }
}
