import AppKit

struct Character {
    var id: String
    var column: Int
    var label: String
    var state: String
}

/// The atlas uses four roles (columns) and idle, speech, blink, working (rows).
final class CharacterView: NSView {
    var atlas: NSImage?
    var characters: [Character] = []
    var speaker: String?
    var mouthUntil: TimeInterval = 0
    var bubble: String = ""
    let accents: [NSColor] = [
        NSColor(red: 0.93, green: 0.78, blue: 0.69, alpha: 1),
        NSColor(red: 0.73, green: 0.51, blue: 0.9, alpha: 1),
        NSColor(red: 0.61, green: 0.81, blue: 0.71, alpha: 1),
        NSColor(red: 0.91, green: 0.56, blue: 0.38, alpha: 1)
    ]
    override var isOpaque: Bool { false }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }

    override func draw(_ dirtyRect: NSRect) {
        guard let atlas else { return }
        NSGraphicsContext.current?.imageInterpolation = .none
        let now = Date.timeIntervalSinceReferenceDate
        let width = bounds.width / CGFloat(max(characters.count, 1))
        for (index, character) in characters.enumerated() {
            let x = CGFloat(index) * width
            let speaking = speaker == character.id
            let blink = now.truncatingRemainder(dividingBy: 4.3) < 0.14
            let row = speaking && now < mouthUntil ? 1 : blink ? 2 : character.state == "working" ? 3 : 0
            let motion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : sin(now * 2 + Double(index)) * 1.5
            let source = NSRect(x: CGFloat(character.column) * atlas.size.width / 4,
                y: CGFloat(3 - row) * atlas.size.height / 4, width: atlas.size.width / 4, height: atlas.size.height / 4)
            atlas.draw(in: NSRect(x: x, y: 36 + motion, width: width, height: 220), from: source,
                       operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
            let accent = accents[min(max(character.column, 0), 3)]
            let badge = NSRect(x: x + 10, y: 12, width: width - 20, height: 28)
            NSColor(calibratedWhite: 0.06, alpha: 0.9).setFill()
            NSBezierPath(roundedRect: badge, xRadius: 8, yRadius: 8).fill()
            let symbol = character.state == "error" ? "! " : character.state == "success" ? "✓ " : character.state == "waiting" ? "? " : ""
            (symbol + character.label as NSString).draw(in: badge.insetBy(dx: 10, dy: 5), withAttributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .bold), .foregroundColor: accent
            ])
        }
        if !bubble.isEmpty {
            let box = NSRect(x: 10, y: 261, width: bounds.width - 20, height: 58)
            NSColor(calibratedWhite: 0.07, alpha: 0.95).setFill()
            NSBezierPath(roundedRect: box, xRadius: 10, yRadius: 10).fill()
            (bubble as NSString).draw(in: box.insetBy(dx: 12, dy: 8), withAttributes: [
                .font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.white
            ])
        }
    }

    func snapshot(_ path: String) {
        guard let bitmap = bitmapImageRepForCachingDisplay(in: bounds) else { return }
        cacheDisplay(in: bounds, to: bitmap)
        try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }
}
