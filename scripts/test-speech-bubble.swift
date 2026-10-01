import AppKit

/// Regression: all glyphs remain available when a long utterance exceeds the bubble.
@main struct SpeechBubbleTests {
    static func main() {
        _ = NSApplication.shared
        let bubble = SpeechBubbleView()
        let samples = ["", "Готово.", String(repeating: "Проверяю изменения и связанные тесты. ", count: 40),
                       String(repeating: "ОченьДлинныйИдентификаторБезПробелов", count: 60),
                       "Первая строка.\n\n👩🏽‍💻 日本語: 動いています。\nПоследняя строка."]
        var checked = 0
        for width in [148.0, 316.0, 652.0] {
            for value in samples {
                let height = bubble.update(value, width: width)
                precondition(bubble.laidOutCharacters == (value as NSString).length, "Missing glyphs at width \(width)")
                precondition(height <= 168 && (value.isEmpty || height >= 54), "Unbounded bubble")
                if !value.isEmpty {
                    precondition((bubble.documentView as? NSTextView)?.string == value, "Utterance truncated")
                    precondition(bubble.hasVerticalScroller == (bubble.contentHeight > height), "Hidden overflow")
                    if bubble.hasVerticalScroller {
                        bubble.contentView.scroll(to: NSPoint(x: 0, y: bubble.contentHeight - height))
                        bubble.reflectScrolledClipView(bubble.contentView)
                        precondition(bubble.documentVisibleRect.maxY >= bubble.contentHeight - 1, "Last line unreachable")
                    }
                }
                checked += 1
            }
        }
        print("PASS \(checked) speech bubble layouts: wrapped text, Unicode, long words, resize and reachable last line")
    }
}
