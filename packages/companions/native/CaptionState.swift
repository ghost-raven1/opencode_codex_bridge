import Foundation

struct CaptionPresentation {
    let characterId: String
    let text: String
    let visible: Int?
    let word: NSRange?
}

/// Keep queued public messages separate, so a newer caption cannot replace speech already playing.
struct CaptionState {
    private struct Caption {
        let characterId: String
        let text: String
        var visible: Int?
        var word: NSRange?
    }
    private struct Fragment {
        let characterId: String
        let captionId: String
        let range: NSRange
        var reveal: SpeechReveal
    }
    private var captions: [String: Caption] = [:]
    private var order: [String] = []
    private var active: Fragment?
    private var focused: String?

    func contains(_ id: String) -> Bool { captions.values.contains { $0.characterId == id } }

    mutating func update(_ id: String, text: String, captionId: String? = nil, animated: Bool = false) {
        if text.isEmpty {
            let removed = Set(captions.filter { $0.value.characterId == id }.map(\.key))
            for key in removed { captions[key] = nil }; order.removeAll { removed.contains($0) }
            if let focused, removed.contains(focused) { self.focused = nil }
            if active?.characterId == id { active = nil }; return
        }
        let key = captionId ?? id
        if captions[key]?.text == text { return }
        captions[key] = Caption(characterId: id, text: text, visible: animated ? 0 : nil)
        if !animated && active == nil { focused = nil }
        order.removeAll { $0 == key }; order.append(key)
        while order.count > 128 {
            guard let index = order.firstIndex(where: { $0 != active?.captionId }) else { break }
            captions[order.remove(at: index)] = nil
        }
    }

    mutating func begin(_ id: String, text: String, captionId: String?, offset: Int) {
        let key = captionId ?? order.last(where: { captions[$0]?.characterId == id }) ?? id
        if captions[key] == nil { update(id, text: text, captionId: key, animated: true) }
        guard let caption = captions[key], caption.characterId == id else { return }
        let full = caption.text as NSString, fragment = text as NSString
        let position = max(0, min(full.length, offset))
        let expected = NSRange(location: position, length: min(fragment.length, full.length - position))
        let range = full.substring(with: expected) == text ? expected : full.range(of: text)
        guard range.location != NSNotFound else { return }
        active = Fragment(characterId: id, captionId: key, range: range, reveal: SpeechReveal(text: text))
        focused = key
        captions[key]?.visible = max(caption.visible ?? 0, range.location)
        captions[key]?.word = nil
    }

    mutating func word(_ id: String, range: NSRange) {
        guard let fragment = active, fragment.characterId == id, range.location >= 0, range.length > 0,
              range.location <= fragment.range.length, range.length <= fragment.range.length - range.location else { return }
        reveal(fragment, length: NSMaxRange(range), word: range)
    }

    mutating func progress(_ id: String, elapsed: Double, duration: Double?, voiced: Bool) {
        guard var fragment = active, fragment.characterId == id else { return }
        let (visible, word) = fragment.reveal.advance(elapsed: elapsed, duration: duration, voiced: voiced)
        active = fragment; reveal(fragment, length: visible, word: word)
    }

    private mutating func reveal(_ fragment: Fragment, length: Int, word: NSRange?) {
        let end = fragment.range.location + min(fragment.range.length, max(0, length))
        if end >= (captions[fragment.captionId]?.visible ?? 0) {
            captions[fragment.captionId]?.visible = end
            captions[fragment.captionId]?.word = word.map { NSRange(location: fragment.range.location + $0.location, length: $0.length) }
        }
    }

    mutating func finish(_ id: String, phase: String) {
        guard let fragment = active, fragment.characterId == id else { return }
        if phase == "end" { reveal(fragment, length: fragment.range.length, word: nil) }
        if phase != "end" {
            captions[fragment.captionId]?.visible = nil
            focused = nil
        } else if let caption = captions[fragment.captionId], NSMaxRange(fragment.range) == caption.text.utf16.count { focused = nil }
        captions[fragment.captionId]?.word = nil; active = nil
    }

    func presentation(visible: Set<String>, preferred: String? = nil) -> CaptionPresentation? {
        let key = active.flatMap { visible.contains($0.characterId) ? $0.captionId : nil }
            ?? focused.flatMap { visible.contains(captions[$0]?.characterId ?? "") ? $0 : nil }
            ?? order.last(where: { visible.contains(captions[$0]?.characterId ?? "") && (preferred == nil || captions[$0]?.characterId == preferred) })
            ?? order.last(where: { visible.contains(captions[$0]?.characterId ?? "") })
        guard let key, let caption = captions[key] else { return nil }
        return CaptionPresentation(characterId: caption.characterId, text: caption.text, visible: caption.visible, word: caption.word)
    }

    func text(visible: Set<String>, preferred: String? = nil) -> String {
        presentation(visible: visible, preferred: preferred)?.text ?? ""
    }
}
