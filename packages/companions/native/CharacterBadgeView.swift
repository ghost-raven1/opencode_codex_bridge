import AppKit

/// Stable AppKit controls avoid rebuilding a bridged font dictionary in every animation frame.
final class CharacterBadgeView: NSView {
    private let label = NSTextField(labelWithString: "")
    private let role = NSTextField(labelWithString: "")
    private let status = NSTextField(labelWithString: "")

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(calibratedWhite: 0.06, alpha: 0.9).cgColor
        layer?.cornerRadius = 8
        for field in [label, role, status] {
            field.font = NSFont(name: "Menlo-Bold", size: 12) ?? NSFont.systemFont(ofSize: 12, weight: .bold)
            field.lineBreakMode = .byTruncatingTail
            addSubview(field)
        }
        role.font = NSFont.systemFont(ofSize: 8, weight: .medium)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func update(_ character: Character, color: NSColor) {
        label.stringValue = character.name ?? character.label
        role.stringValue = character.name == nil ? "" : character.label.replacingOccurrences(of: "CODEX · ", with: "")
        role.textColor = color.withAlphaComponent(0.8)
        label.textColor = color; status.textColor = color
        status.stringValue = ["success": "OK", "error": "!", "waiting": "?"][character.state] ?? ""
        toolTip = [character.name, character.label].compactMap { $0 }.joined(separator: " · ")
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let inset: CGFloat = status.stringValue.isEmpty ? 10 : 35
        status.frame = NSRect(x: 9, y: 5, width: 25, height: 18)
        let available = max(1, bounds.width - inset - 8)
        // NSTextField's cell needs a few extra points beyond the intrinsic glyph width.
        let nameMinimum = ceil(label.intrinsicContentSize.width) + 6
        let roleWidth = role.stringValue.isEmpty ? 0 : min(ceil(role.intrinsicContentSize.width) + 6, max(0, available - nameMinimum - 5))
        let gap: CGFloat = roleWidth > 0 ? 5 : 0
        let nameWidth = max(1, available - roleWidth - gap)
        label.frame = NSRect(x: inset, y: 5, width: nameWidth, height: 18)
        role.frame = NSRect(x: inset + nameWidth + gap, y: 7, width: roleWidth, height: 13)
    }
}
