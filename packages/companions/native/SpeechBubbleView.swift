import AppKit

/// Wrap the complete utterance; tall messages remain selectable and scrollable.
final class SpeechBubbleView: NSScrollView {
    private let text = NSTextView()
    private(set) var contentHeight: CGFloat = 0
    private(set) var laidOutCharacters = 0
    private var lastWidth: CGFloat = 0
    private var lastText = ""
    private var visibleCharacters: Int?
    private var currentWord: NSRange?
    private var fading: NSRange?
    private var fadeStarted = 0.0
    private var manualScroll = false
    var accent = NSColor.systemPurple

    init() {
        super.init(frame: .zero)
        drawsBackground = true
        backgroundColor = NSColor(calibratedWhite: 0.07, alpha: 0.97)
        wantsLayer = true; layer?.cornerRadius = 12
        layer?.borderWidth = 1; layer?.borderColor = NSColor.white.withAlphaComponent(0.16).cgColor
        hasHorizontalScroller = false; autohidesScrollers = false
        scrollerStyle = .legacy; borderType = .noBorder
        text.isEditable = false; text.isSelectable = true
        text.drawsBackground = false; text.textColor = .white
        text.font = NSFont.systemFont(ofSize: 13)
        text.textContainerInset = NSSize(width: 12, height: 10)
        text.textContainer?.lineFragmentPadding = 0
        text.isHorizontallyResizable = false; text.isVerticallyResizable = true
        text.textContainer?.widthTracksTextView = false
        text.setAccessibilityLabel("Реплика агента")
        documentView = text; isHidden = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Measure against the final width, reserving scrollbar space before wrapping.
    @discardableResult func update(_ value: String, width: CGFloat) -> CGFloat {
        let width = max(100, width)
        if value == lastText && width == lastWidth { return isHidden ? 0 : frame.height }
        let changed = value != lastText
        lastText = value; lastWidth = width
        isHidden = value.isEmpty
        guard !value.isEmpty else { contentHeight = 0; laidOutCharacters = 0; return 0 }
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping; paragraph.lineSpacing = 2
        text.textStorage?.setAttributedString(NSAttributedString(string: value, attributes: [
            .font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.white, .paragraphStyle: paragraph
        ]))
        let gutter = NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy)
        let documentWidth = width - gutter
        text.textContainer?.containerSize = NSSize(width: max(1, documentWidth - 24), height: .greatestFiniteMagnitude)
        if let container = text.textContainer, let layout = text.layoutManager {
            layout.ensureLayout(for: container)
            contentHeight = ceil(layout.usedRect(for: container).height) + 20
            laidOutCharacters = layout.characterRange(forGlyphRange: layout.glyphRange(for: container), actualGlyphRange: nil).length
        }
        let height = min(168, max(54, contentHeight))
        hasVerticalScroller = contentHeight > height
        frame.size = NSSize(width: width, height: height)
        text.setFrameSize(NSSize(width: documentWidth, height: max(height, contentHeight)))
        if changed {
            visibleCharacters = nil; currentWord = nil; fading = nil; manualScroll = false
            contentView.scroll(to: .zero); reflectScrolledClipView(contentView)
        }
        else { applyColors() }
        toolTip = hasVerticalScroller ? "Прокрути, чтобы прочитать всю реплику. Текст можно выделить и скопировать." : nil
        return height
    }

    /// Preserve complete text/layout for selection; only the spoken prefix receives full contrast.
    func reveal(until requested: Int?, word: NSRange?, reduced: Bool) {
        let length = (lastText as NSString).length
        let visible = requested.map { max(0, min(length, $0)) }
        guard visible != visibleCharacters || word != currentWord else { return }
        if let visible, let old = visibleCharacters, visible > old, !reduced {
            fading = NSRange(location: old, length: visible - old)
            fadeStarted = Date.timeIntervalSinceReferenceDate
        } else { fading = nil }
        visibleCharacters = visible
        currentWord = word.flatMap { $0.location >= 0 && NSMaxRange($0) <= length ? $0 : nil }
        applyColors()
        if !manualScroll, let word = currentWord { text.scrollRangeToVisible(word) }
    }

    func tick(at time: Double, reduced: Bool) {
        guard let range = fading else { return }
        let progress = reduced ? 1 : min(1, max(0, (time - fadeStarted) / 0.16))
        text.textStorage?.addAttribute(.foregroundColor, value: NSColor.white.withAlphaComponent(0.18 + progress * 0.82), range: range)
        if progress >= 1 { fading = nil; applyColors() }
    }

    private func applyColors() {
        guard let storage = text.textStorage else { return }
        storage.beginEditing()
        let full = NSRange(location: 0, length: storage.length)
        storage.addAttribute(.foregroundColor, value: NSColor.white.withAlphaComponent(visibleCharacters == nil ? 1 : 0.18), range: full)
        storage.removeAttribute(.backgroundColor, range: full)
        if let visibleCharacters {
            storage.addAttribute(.foregroundColor, value: NSColor.white, range: NSRange(location: 0, length: visibleCharacters))
        }
        if let currentWord { storage.addAttribute(.backgroundColor, value: accent.withAlphaComponent(0.18), range: currentWord) }
        if let fading { storage.addAttribute(.foregroundColor, value: NSColor.white.withAlphaComponent(0.18), range: fading) }
        storage.endEditing()
    }

    override func scrollWheel(with event: NSEvent) { manualScroll = true; super.scrollWheel(with: event) }

    var diagnostics: [String: Any] {
        ["characters": (lastText as NSString).length, "laidOutCharacters": laidOutCharacters,
         "contentHeight": contentHeight, "visibleHeight": frame.height, "scrollable": hasVerticalScroller,
         "revealedCharacters": visibleCharacters ?? (lastText as NSString).length]
    }
}
