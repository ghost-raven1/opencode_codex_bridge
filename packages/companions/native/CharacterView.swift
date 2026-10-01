import AppKit

struct Character {
    var id: String
    var column: Int
    var label: String
    var state: String
    var headColumn: Int
    var bodyColumn: Int

    init(id: String, column: Int, label: String, state: String, headColumn: Int? = nil, bodyColumn: Int? = nil) {
        self.id = id; self.column = min(max(column, 0), 3); self.label = label; self.state = state
        self.headColumn = min(max(headColumn ?? column, 0), 3)
        self.bodyColumn = min(max(bodyColumn ?? column, 0), 3)
    }
}

/// The atlas uses four roles (columns) and idle, speech, blink, working (rows).
final class CharacterView: NSView {
    var atlas: NSImage?
    var headAtlas: NSImage?
    var bodyAtlas: NSImage?
    var poseAtlas: NSImage?
    var transitionAtlas: NSImage?
    var characters: [Character] = []
    var speaker: String?
    var mouthUntil: TimeInterval = 0
    var bubble: String = ""
    private var dragStart: NSPoint?
    let accents: [NSColor] = [
        NSColor(red: 0.93, green: 0.78, blue: 0.69, alpha: 1),
        NSColor(red: 0.73, green: 0.51, blue: 0.9, alpha: 1),
        NSColor(red: 0.61, green: 0.81, blue: 0.71, alpha: 1),
        NSColor(red: 0.91, green: 0.56, blue: 0.38, alpha: 1)
    ]
    override var isOpaque: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func mouseDown(with event: NSEvent) {
        dragStart = event.locationInWindow
        NSCursor.closedHand.set()
    }
    override func mouseDragged(with event: NSEvent) {
        guard let dragStart, let window else { return }
        let point = window.convertPoint(toScreen: event.locationInWindow)
        window.setFrameOrigin(NSPoint(x: point.x - dragStart.x, y: point.y - dragStart.y))
    }
    override func mouseUp(with event: NSEvent) {
        dragStart = nil; NSCursor.openHand.set()
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let atlas else { return }
        NSGraphicsContext.current?.imageInterpolation = .none
        let now = Date.timeIntervalSinceReferenceDate
        let width = bounds.width / CGFloat(max(characters.count, 1))
        for (index, character) in characters.enumerated() {
            let x = CGFloat(index) * width
            let speaking = speaker == character.id
            let blink = (now + Double(index) * 0.73).truncatingRemainder(dividingBy: 4.3) < 0.14
            let row = speaking && now < mouthUntil ? 1 : blink ? 2 : character.state == "working" ? 3 : 0
            let motion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : sin(now * 2 + Double(index)) * 1.5
            let cellWidth = atlas.size.width / 4, cellHeight = atlas.size.height / 4
            let factor = min(width / cellWidth, 220 / cellHeight)
            let target = NSRect(x: x + (width - cellWidth * factor) / 2, y: 36 + motion,
                                width: cellWidth * factor, height: cellHeight * factor)
            if character.headColumn == character.bodyColumn, let poseAtlas, let transitionAtlas {
                let frame = animationFrame(character, now: now + Double(index) * 0.73,
                    speaking: speaking, mouthOpen: now < mouthUntil, base: atlas, poses: poseAtlas, transitions: transitionAtlas)
                drawFrame(frame.image, column: character.bodyColumn, row: frame.row, rows: frame.rows, target: target)
            } else if let headAtlas, let bodyAtlas {
                drawFrame(bodyAtlas, column: character.bodyColumn, row: row, target: target)
                drawFrame(headAtlas, column: character.headColumn, row: row, target: target)
            } else {
                drawFrame(atlas, column: character.column, row: row, target: target)
            }
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

    /// Both layers share a neck anchor; compositing preserves the drawn hair and outfit accessories.
    private func drawFrame(_ image: NSImage, column: Int, row: Int, rows: Int = 4, target: NSRect) {
        let source = NSRect(x: CGFloat(column) * image.size.width / 4,
            y: CGFloat(rows - 1 - row) * image.size.height / CGFloat(rows),
            width: image.size.width / 4, height: image.size.height / CGFloat(rows))
        image.draw(in: target, from: source, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
    }

    /// Drawn poses follow task state; mouth frames are gated by real speech activity, not estimated text length.
    private func animationFrame(_ character: Character, now: TimeInterval, speaking: Bool, mouthOpen: Bool,
        base: NSImage, poses: NSImage, transitions: NSImage) -> (image: NSImage, row: Int, rows: Int) {
        let reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if speaking {
            guard mouthOpen && !reduced else { return (base, 0, 4) }
            return Int(now * 12) % 3 == 0 ? (transitions, 2, 5) : (transitions, 4, 5)
        }
        let posesByState = ["thinking": 0, "working": 1, "success": 2, "waiting": 3, "error": 4]
        if let row = posesByState[character.state] {
            if character.state == "working" && !reduced && now.truncatingRemainder(dividingBy: 2.4) > 1.8 {
                return (base, 3, 4)
            }
            return (poses, row, 5)
        }
        guard !reduced else { return (base, 0, 4) }
        let blink = now.truncatingRemainder(dividingBy: 4.3)
        if blink < 0.07 || (blink > 0.14 && blink < 0.21) { return (transitions, 1, 5) }
        if blink < 0.14 { return (transitions, 3, 5) }
        return now.truncatingRemainder(dividingBy: 6) > 4.6 ? (transitions, 0, 5) : (base, 0, 4)
    }

    func snapshot(_ path: String) {
        guard let bitmap = bitmapImageRepForCachingDisplay(in: bounds) else { return }
        cacheDisplay(in: bounds, to: bitmap)
        try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }
}
