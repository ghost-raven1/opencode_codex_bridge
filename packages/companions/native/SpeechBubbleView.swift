import AppKit

/// Wrap the complete utterance; tall messages remain selectable and scrollable.
final class SpeechBubbleView: NSScrollView {
    private let text = NSTextView()
    private(set) var contentHeight: CGFloat = 0
    private(set) var laidOutCharacters = 0
    private var lastWidth: CGFloat = 0
    private var lastText = ""

    init() {
        super.init(frame: .zero)
        drawsBackground = true
        backgroundColor = NSColor(calibratedWhite: 0.07, alpha: 0.97)
        wantsLayer = true; layer?.cornerRadius = 10
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
        if changed { contentView.scroll(to: .zero); reflectScrolledClipView(contentView) }
        toolTip = hasVerticalScroller ? "Прокрути, чтобы прочитать всю реплику. Текст можно выделить и скопировать." : nil
        return height
    }

    var diagnostics: [String: Any] {
        ["characters": (lastText as NSString).length, "laidOutCharacters": laidOutCharacters,
         "contentHeight": contentHeight, "visibleHeight": frame.height, "scrollable": hasVerticalScroller]
    }
}
