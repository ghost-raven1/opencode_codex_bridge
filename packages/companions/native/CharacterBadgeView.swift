import AppKit

/// Stable AppKit controls avoid rebuilding a bridged font dictionary in every animation frame.
final class CharacterBadgeView: NSView {
    private let label = NSTextField(labelWithString: "")
    private let status = NSTextField(labelWithString: "")

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(calibratedWhite: 0.06, alpha: 0.9).cgColor
        layer?.cornerRadius = 8
        for field in [label, status] {
            field.font = NSFont(name: "Menlo-Bold", size: 12) ?? NSFont.systemFont(ofSize: 12, weight: .bold)
            field.lineBreakMode = .byTruncatingTail
            addSubview(field)
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func update(_ character: Character, color: NSColor) {
        label.stringValue = character.label
        label.textColor = color; status.textColor = color
        status.stringValue = ["success": "OK", "error": "!", "waiting": "?"][character.state] ?? ""
        toolTip = character.label
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let inset: CGFloat = status.stringValue.isEmpty ? 10 : 35
        status.frame = NSRect(x: 9, y: 5, width: 25, height: 18)
        label.frame = NSRect(x: inset, y: 5, width: max(1, bounds.width - inset - 8), height: 18)
    }
}
