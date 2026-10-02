import AppKit

/// Native transparent, draggable sprites. Rendering sleeps whenever the panel is hidden or empty.
final class CharacterView: NSView {
    var atlas: NSImage?
    var headAtlas: NSImage?
    var bodyAtlas: NSImage?
    var mixedHeadAtlas: NSImage?
    var mixedBodyAtlas: NSImage?
    var faceAtlas: NSImage?
    private let sprites = SpriteCache()
    var characters: [Character] = []
    private var motions: [String: Motion] = [:]
    private var ambient: [String: AmbientMotion] = [:]
    private var badges: [String: CharacterBadgeView] = [:]
    var speaker: String?
    var mouthUntil: TimeInterval = 0
    var mouthLevel: Double = 0
    let speechBubble = SpeechBubbleView()
    var onBubbleChange: (() -> Void)?
    var bubble = "" { didSet { onBubbleChange?(); needsDisplay = true } }
    var snapshotBackground: String?
    var snapshotTime: TimeInterval?
    private var dragStart: NSPoint?
    var reduced: Bool { CommandLine.arguments.contains("--reduce-motion") || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    private var now: TimeInterval { snapshotTime ?? Date.timeIntervalSinceReferenceDate }
    let accents: [NSColor] = [
        NSColor(red: 0.93, green: 0.78, blue: 0.69, alpha: 1),
        NSColor(red: 0.73, green: 0.51, blue: 0.9, alpha: 1),
        NSColor(red: 0.61, green: 0.81, blue: 0.71, alpha: 1),
        NSColor(red: 0.91, green: 0.56, blue: 0.38, alpha: 1)
    ]
    override var isOpaque: Bool { false }
    override init(frame: NSRect) { super.init(frame: frame); addSubview(speechBubble) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func contentHeight(width: CGFloat) -> CGFloat {
        let height = speechBubble.update(bubble, width: width - 20)
        speechBubble.setFrameOrigin(NSPoint(x: 10, y: 261))
        return max(330, 273 + height)
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func mouseDown(with event: NSEvent) { dragStart = event.locationInWindow; NSCursor.closedHand.set() }
    override func mouseDragged(with event: NSEvent) {
        guard let dragStart, let window else { return }
        let point = window.convertPoint(toScreen: event.locationInWindow)
        window.setFrameOrigin(NSPoint(x: point.x - dragStart.x, y: point.y - dragStart.y))
    }
    override func mouseUp(with event: NSEvent) { dragStart = nil; NSCursor.openHand.set() }

    func update(_ character: Character) {
        let time = now
        if let index = characters.firstIndex(where: { $0.id == character.id }) {
            let old = characters[index]
            if !old.looksLike(character) {
                let previous = motions[old.id].flatMap { $0.kind == "turn" && $0.progress(time, reduced: reduced) < 0.5 ? $0.previous : nil } ?? old
                motions[old.id] = Motion(kind: "turn", start: time, previous: previous)
            } else if motions[old.id]?.kind == "leave" {
                motions[old.id] = Motion(kind: "enter", start: time)
            }
            characters[index] = character
        } else {
            characters.append(character); motions[character.id] = Motion(kind: "enter", start: time)
            ambient[character.id] = AmbientMotion(now: time)
        }
        let badge = badges[character.id] ?? CharacterBadgeView(frame: .zero)
        if badge.superview == nil { addSubview(badge); badges[character.id] = badge }
        badge.update(character, color: accents[character.column])
        layoutBadges()
    }

    func remove(_ id: String, immediately: Bool = false) {
        guard characters.contains(where: { $0.id == id }) else { return }
        if immediately { characters.removeAll { $0.id == id }; motions[id] = nil; ambient[id] = nil; badges.removeValue(forKey: id)?.removeFromSuperview() }
        else { motions[id] = Motion(kind: "leave", start: now) }
    }

    func replace(_ entries: [Character], animated: Bool = true) {
        badges.values.forEach { $0.removeFromSuperview() }; badges = [:]
        characters = []; motions = [:]; ambient = [:]
        for entry in entries { update(entry) }
        if !animated { motions = [:]; layoutBadges() }
    }

    @discardableResult func tick() -> Bool {
        let before = characters.count, time = now
        for (id, motion) in motions where motion.progress(time, reduced: reduced) >= 1 {
            if motion.kind == "leave" { characters.removeAll { $0.id == id }; ambient[id] = nil; badges.removeValue(forKey: id)?.removeFromSuperview() }
            motions[id] = nil
        }
        for id in ambient.keys { ambient[id]?.advance(time) }
        layoutBadges()
        needsDisplay = true
        return before != characters.count
    }

    override func layout() { super.layout(); layoutBadges() }

    private func layoutBadges() {
        let width = bounds.width / CGFloat(max(characters.count, 1))
        for (index, character) in characters.enumerated() {
            guard let badge = badges[character.id] else { continue }
            badge.frame = NSRect(x: CGFloat(index) * width + 10, y: 12, width: width - 20, height: 28)
            let motion = motions[character.id], progress = motion?.progress(now, reduced: reduced) ?? 1
            badge.alphaValue = motion?.kind == "leave" ? 1 - progress : motion?.kind == "enter" ? min(1, progress * 2) : 1
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let atlas else { return }
        if let background = snapshotBackground {
            (background == "light" ? NSColor.white : NSColor(calibratedWhite: 0.06, alpha: 1)).setFill(); bounds.fill()
        }
        NSGraphicsContext.current?.imageInterpolation = .none
        let time = now, width = bounds.width / CGFloat(max(characters.count, 1))
        for (index, character) in characters.enumerated() {
            let x = CGFloat(index) * width
            let motion = motions[character.id], progress = motion?.progress(time, reduced: reduced) ?? 1
            let displayed = motion?.kind == "turn" && progress < 0.5 ? motion?.previous ?? character : character
            let accent = accents[character.column]
            let speaking = speaker == character.id, blink = ambient[character.id].map { time >= $0.blinkAt && time < $0.blinkAt + 0.30 } ?? false
            let faceRows = FacialMotion.rows(state: displayed.state, speaking: speaking, open: time < mouthUntil,
                                             level: mouthLevel, time: time,
                                             blinkElapsed: !reduced && blink ? time - (ambient[character.id]?.blinkAt ?? time) : nil)
            let factor = min(width / 256, 220.0 / 384)
            let gesture = ambient[character.id]?.gestureStart
            let pose = LayeredMotion.pose(state: displayed.state, time: time,
                gestureElapsed: gesture.map { time - $0 }, speaking: speaking, reduced: reduced, seed: index)
            var target = NSRect(x: x + (width - 256 * factor) / 2, y: 36,
                                width: 256 * factor, height: 384 * factor * pose.bodyScaleY)
            var opacity = 1.0
            if let motion {
                if motion.kind == "enter" { opacity = min(1, progress * 2) }
                if motion.kind == "leave" { opacity = 1 - progress }
                if motion.kind == "turn" {
                    if reduced { opacity = abs(progress * 2 - 1) }
                    else { target = target.insetBy(dx: target.width * 0.25 * sin(progress * .pi), dy: 0) }
                }
            }
            let scale = (window?.frame.width ?? bounds.width) / max(1, bounds.width)
            let radius = 1 / max(0.25, factor * scale * (window?.backingScaleFactor ?? 2))
            if let sourceHead = mixedHeadAtlas ?? headAtlas, let sourceBody = mixedBodyAtlas ?? bodyAtlas {
                sprites.frame(sourceBody, column: displayed.bodyColumn, row: 0, rows: 4, radius: radius)?
                    .draw(in: target, from: .zero, operation: .sourceOver, fraction: opacity)
                let head = sprites.frame(sourceHead, column: displayed.headColumn, row: 0, rows: 4, radius: radius,
                    face: faceAtlas, faceColumn: displayed.headColumn, faceRows: faceRows)
                let neck = LayeredMotion.neck
                let pivot = NSPoint(x: target.minX + neck.x * target.width / 256,
                                    y: target.minY + neck.y * target.height / 384)
                NSGraphicsContext.saveGraphicsState()
                let transform = NSAffineTransform()
                transform.translateX(by: pivot.x + pose.headX * factor, yBy: pivot.y + pose.headY * factor)
                transform.rotate(byDegrees: pose.headAngle)
                transform.translateX(by: -pivot.x, yBy: -pivot.y); transform.concat()
                head?.draw(in: target, from: .zero, operation: .sourceOver, fraction: opacity)
                NSGraphicsContext.restoreGraphicsState()
            } else {
                sprites.frame(atlas, column: displayed.bodyColumn, row: 0, rows: 4, radius: radius,
                    face: faceAtlas, faceColumn: displayed.headColumn, faceRows: faceRows)?
                    .draw(in: target, from: .zero, operation: .sourceOver, fraction: opacity)
            }
            if !reduced, let motion { drawParticles(target, kind: motion.kind, progress: progress, accent: accent, seed: index) }
        }
    }

    private func drawParticles(_ rect: NSRect, kind: String, progress: Double, accent: NSColor, seed: Int) {
        if kind == "turn" {
            accent.withAlphaComponent(0.18 * sin(progress * .pi)).setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 14, dy: 8)).fill()
        }
        for n in 0..<18 {
            let angle = Double(n) * 2.399 + Double(seed), t = kind == "enter" ? 1 - progress : progress
            let reach = 15 + t * 46
            let x = rect.midX + cos(angle) * (rect.width * 0.38 + reach)
            let y = rect.minY + Double((n * 37) % 190) + sin(angle) * reach
            accent.withAlphaComponent(sin(progress * .pi) * 0.85).setFill()
            NSRect(x: x.rounded(), y: y.rounded(), width: n % 3 == 0 ? 4 : 2, height: n % 3 == 0 ? 4 : 2).fill()
        }
    }

    @discardableResult func snapshot(_ path: String) -> Bool {
        guard let bitmap = bitmapImageRepForCachingDisplay(in: bounds) else { return false }
        cacheDisplay(in: bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else { return false }
        do { try data.write(to: URL(fileURLWithPath: path), options: .atomic); return true }
        catch { return false }
    }
}
