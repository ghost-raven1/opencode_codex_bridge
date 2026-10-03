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
    private var rigs: [String: LayeredRig] = [:]
    private var poseRigs: PoseRigLibrary?
    var characters: [Character] = []
    private var motions: [String: Motion] = [:]
    private var ambient: [String: AmbientMotion] = [:]
    private var workAnimations: [String: WorkAnimation] = [:]
    private var poseAnimations: [String: PoseAnimation] = [:]
    private var previousPostures: [String: PoseAnimation] = [:]
    private var team = TeamCoordinator()
    var teamActionKinds: [String] { team.actions.map { $0.kind.rawValue } }
    private var badges: [String: CharacterBadgeView] = [:]
    var speaker: String?
    var mouthUntil: TimeInterval = 0
    var mouthLevel: Double = 0
    var musicBeat: MusicBeatState?
    let speechBubble = SpeechBubbleView()
    var onBubbleChange: (() -> Void)?
    var onResize: ((Double) -> Void)?
    var bubble = "" { didSet { onBubbleChange?(); needsDisplay = true } }
    var snapshotBackground: String?
    var snapshotTime: TimeInterval?
    private var dragStart: NSPoint?
    private var resizeStart: (point: NSPoint, size: NSSize, scale: Double)?
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

    func loadRigs(directory: URL) {
        rigs = LayeredRig.load(directory: directory)
        poseRigs = PoseRigLibrary(directory: directory)
    }

    func contentHeight(width: CGFloat) -> CGFloat {
        let height = speechBubble.update(bubble, width: width - 20)
        speechBubble.setFrameOrigin(NSPoint(x: 10, y: 261))
        return max(330, 273 + height)
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    var resizeHandle: NSRect { NSRect(x: bounds.maxX - 24, y: 0, width: 24, height: 12) }
    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .openHand)
        if onResize != nil { addCursorRect(resizeHandle, cursor: .resizeLeftRight) }
    }
    override func mouseDown(with event: NSEvent) {
        if onResize != nil, resizeHandle.contains(convert(event.locationInWindow, from: nil)), let window {
            resizeStart = (window.convertPoint(toScreen: event.locationInWindow), frame.size, frame.width / bounds.width)
            dragStart = nil
        } else { dragStart = event.locationInWindow; NSCursor.closedHand.set() }
    }
    override func mouseDragged(with event: NSEvent) {
        if let start = resizeStart, let window {
            let point = window.convertPoint(toScreen: event.locationInWindow)
            let horizontal = (point.x - start.point.x) / start.size.width
            let vertical = (start.point.y - point.y) / start.size.height
            let top = window.frame.maxY
            onResize?(start.scale * (1 + (abs(horizontal) >= abs(vertical) ? horizontal : vertical)))
            // Dragging the lower corner keeps the opposite top edge under the pointer.
            let minimumY = window.screen?.visibleFrame.minY ?? -CGFloat.greatestFiniteMagnitude
            window.setFrameOrigin(NSPoint(x: window.frame.minX, y: max(minimumY, top - window.frame.height)))
            return
        }
        guard let dragStart, let window else { return }
        let point = window.convertPoint(toScreen: event.locationInWindow)
        window.setFrameOrigin(NSPoint(x: point.x - dragStart.x, y: point.y - dragStart.y))
    }
    override func mouseUp(with event: NSEvent) { dragStart = nil; resizeStart = nil; NSCursor.openHand.set() }

    func update(_ character: Character, animateInteractions: Bool = true) {
        let time = now
        if let index = characters.firstIndex(where: { $0.id == character.id }) {
            let old = characters[index]
            if !old.looksLike(character) {
                let previous = motions[old.id].flatMap { $0.kind == "turn" && $0.progress(time, reduced: reduced) < 0.5 ? $0.previous : nil }
                if previous == nil || previousPostures[old.id] == nil {
                    _ = posture(for: old, at: time)
                    previousPostures[old.id] = poseAnimations[old.id]
                }
                motions[old.id] = Motion(kind: "turn", start: time, previous: previous ?? old)
            } else if let leaving = motions[old.id], leaving.kind == "leave" {
                let opacity = SpriteTransition.frame(kind: "leave", progress: leaving.progress(time, reduced: reduced), reduced: reduced).opacity
                motions[old.id] = Motion(kind: "enter", start: time, initialOpacity: opacity)
            }
            characters[index] = character
        } else {
            characters.append(character); motions[character.id] = Motion(kind: "enter", start: time)
            ambient[character.id] = AmbientMotion(now: time, gestureInterval: gestureInterval(for: character))
        }
        let badge = badges[character.id] ?? CharacterBadgeView(frame: .zero)
        var work = workAnimations[character.id] ?? WorkAnimation(seed: character.id)
        work.update(active: ["working", "thinking"].contains(character.state), at: time)
        workAnimations[character.id] = work
        let delay = motions[character.id].map { (1 - $0.progress(time, reduced: reduced)) * $0.duration(reduced: reduced) } ?? 0
        team.observe(character, at: time, entranceDelay: delay, animated: animateInteractions)
        _ = posture(for: character, at: time)
        if badge.superview == nil { addSubview(badge); badges[character.id] = badge }
        badge.update(character, color: accent(for: character))
        layoutBadges()
    }

    func remove(_ id: String, immediately: Bool = false) {
        guard characters.contains(where: { $0.id == id }) else { return }
        team.remove(id)
        if immediately { characters.removeAll { $0.id == id }; motions[id] = nil; ambient[id] = nil; workAnimations[id] = nil; poseAnimations[id] = nil; previousPostures[id] = nil; badges.removeValue(forKey: id)?.removeFromSuperview() }
        else { motions[id] = Motion(kind: "leave", start: now) }
    }

    func replace(_ entries: [Character], animated: Bool = true) {
        let next = Set(entries.map(\.id))
        for character in characters where !next.contains(character.id) { team.remove(character.id) }
        badges.values.forEach { $0.removeFromSuperview() }; badges = [:]
        characters = []; motions = [:]; ambient = [:]; workAnimations = [:]; poseAnimations = [:]; previousPostures = [:]
        for entry in entries { update(entry, animateInteractions: animated) }
        if !animated { motions = [:]; layoutBadges() }
    }

    @discardableResult func tick() -> Bool {
        let before = characters.count, time = now
        team.tick(at: time)
        for (id, motion) in motions where motion.progress(time, reduced: reduced) >= 1 {
            if motion.kind == "leave" { characters.removeAll { $0.id == id }; ambient[id] = nil; workAnimations[id] = nil; poseAnimations[id] = nil; badges.removeValue(forKey: id)?.removeFromSuperview() }
            motions[id] = nil; previousPostures[id] = nil
        }
        for character in characters {
            ambient[character.id]?.advance(time, gestureInterval: gestureInterval(for: character))
            _ = posture(for: character, at: time)
        }
        layoutBadges()
        needsDisplay = true
        return before != characters.count
    }

    override func layout() { super.layout(); layoutBadges() }

    private func gestureInterval(for character: Character) -> ClosedRange<Double> {
        character.rig.flatMap { rigs[$0]?.gestureInterval } ?? 8...15
    }

    private func accent(for character: Character) -> NSColor {
        switch character.rig {
        case "designer": return .systemPink
        case "devops": return .systemCyan
        case "tester": return .systemYellow
        default: return accents[character.column]
        }
    }

    private func rigNames(for character: Character) -> (body: String, head: String?) {
        let core = ["lead", "code", "research", "review"]
        return (character.rig ?? core[character.bodyColumn],
                character.rig == nil && character.headColumn != character.bodyColumn ? core[character.headColumn] : nil)
    }

    /// A mixed identity changes posture only when both its outfit and original head have that pose.
    func posture(for character: Character, at time: TimeInterval) -> PoseFrame {
        let names = rigNames(for: character)
        var available = Set(CharacterPose.allCases.filter { pose in
            pose != .standing && poseRigs?.contains("\(names.body)/\(pose.rawValue)") == true &&
                (names.head == nil || poseRigs?.contains("\(names.head!)/\(pose.rawValue)") == true)
        })
        var animation = poseAnimations[character.id] ?? PoseAnimation(seed: character.id)
        let dancing = MusicMotion.pose(beat: musicBeat, time: time, column: character.column, rig: character.rig, reduced: reduced).strength > 0
        let identity = "\(names.body):\(names.head ?? names.body):\(character.name ?? "")"
        var result = animation.advance(identity: identity,
            state: character.state, speaking: speaker == character.id || team.action(for: character.id, at: time) != nil,
            dancing: dancing, available: available, at: time, reduced: reduced)
        if animation.requested != .standing {
            let key = animation.requested.rawValue
            if poseRigs?.rig("\(names.body)/\(key)") == nil || (names.head != nil && poseRigs?.rig("\(names.head!)/\(key)") == nil) {
                available.remove(animation.requested)
                result = animation.advance(identity: identity, state: character.state, speaking: speaker == character.id,
                    dancing: dancing, available: available, at: time, reduced: reduced)
            }
        }
        poseAnimations[character.id] = animation
        return result
    }

    func displayPosture(for character: Character, at time: TimeInterval) -> PoseFrame {
        if let motion = motions[character.id], motion.kind == "turn", motion.progress(time, reduced: reduced) < 0.5,
           let previous = previousPostures[character.id] { return previous.frame(at: time, reduced: reduced) }
        return posture(for: character, at: time)
    }

    private func layoutBadges() {
        let width = bounds.width / CGFloat(max(characters.count, 1))
        for (index, character) in characters.enumerated() {
            guard let badge = badges[character.id] else { continue }
            badge.frame = NSRect(x: CGFloat(index) * width + 10, y: 12, width: width - 20, height: 28)
            let motion = motions[character.id], progress = motion?.progress(now, reduced: reduced) ?? 1
            badge.alphaValue = motion.flatMap { ["leave", "enter"].contains($0.kind)
                ? SpriteTransition.frame(kind: $0.kind, progress: progress, reduced: reduced, initialOpacity: $0.initialOpacity).opacity : nil } ?? 1
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        // Transparent backing stores retain old pixels unless this frame replaces them.
        NSColor.clear.setFill(); dirtyRect.fill(using: .copy)
        guard let atlas else { return }
        if let background = snapshotBackground {
            (background == "light" ? NSColor.white : NSColor(calibratedWhite: 0.06, alpha: 1)).setFill(); bounds.fill()
        }
        NSGraphicsContext.current?.imageInterpolation = .none
        let time = now, width = bounds.width / CGFloat(max(characters.count, 1))
        var centers: [String: NSPoint] = [:], colors: [String: NSColor] = [:]
        for (index, character) in characters.enumerated() {
            let x = CGFloat(index) * width
            let motion = motions[character.id], progress = motion?.progress(time, reduced: reduced) ?? 1
            let displayed = motion?.kind == "turn" && progress < 0.5 ? motion?.previous ?? character : character
            let accent = accent(for: character)
            let speaking = speaker == character.id, blink = ambient[character.id].map { time >= $0.blinkAt && time < $0.blinkAt + 0.30 } ?? false
            var faceRows = FacialMotion.rows(state: displayed.state, speaking: speaking, open: time < mouthUntil,
                                             level: mouthLevel, time: time,
                                             blinkElapsed: !reduced && blink ? time - (ambient[character.id]?.blinkAt ?? time) : nil)
            let factor = min(width / 256, 220.0 / 384)
            let gesture = ambient[character.id]?.gestureStart
            let interaction = team.action(for: character.id, at: time)
            if !speaking, !reduced, let interaction, let expression = TeamMotion.face(interaction, id: character.id, at: time) { faceRows[0] = expression }
            let names = rigNames(for: displayed), rigName = names.body
            let posture = displayPosture(for: character, at: time)
            let rig = posture.kind == .standing ? rigs[rigName] : poseRigs?.rig("\(rigName)/\(posture.kind.rawValue)") ?? rigs[rigName]
            let mixedHead = names.head.flatMap { name in
                posture.kind == .standing ? rigs[name] : poseRigs?.rig("\(name)/\(posture.kind.rawValue)") ?? rigs[name]
            }
            let motionTime = rig.map { time * 2 * .pi / (1.35 * $0.definition.motion.breathSeconds) } ?? time
            var pose = LayeredMotion.pose(state: displayed.state, time: motionTime,
                gestureElapsed: gesture.map { (time - $0) * 3.6 / (rig?.definition.motion.gestureSeconds ?? 3.6) },
                speaking: speaking, reduced: reduced, seed: character.motionSeed)
            let dance = MusicMotion.pose(beat: musicBeat, time: time, column: displayed.column, rig: displayed.rig, reduced: reduced)
            pose.headX += dance.headX; pose.headY += dance.headY; pose.headAngle += dance.headAngle
            let idle = IdleMotion.pose(rig: rigName, state: displayed.state, time: time, gestureElapsed: gesture.map { time - $0 },
                variant: (ambient[character.id]?.gestureIndex ?? 0) + character.motionSeed, seed: character.motionSeed, reduced: reduced)
            var work = workAnimations[character.id]?.pose(rig: rigName, at: time, reduced: reduced, rest: idle) ?? idle
            if let interaction, let peer = characters.firstIndex(where: { $0.id == (interaction.source == character.id ? interaction.target : interaction.source) }) {
                let direction = peer > index ? 1.0 : -1.0
                let reaction = TeamMotion.pose(interaction, id: character.id, rig: rigName, direction: direction, at: time, reduced: reduced)
                work = work.blending(reaction, weight: pow(sin(interaction.progress(at: time) * .pi), 2) * (speaking ? 0.35 : 1))
            }
            work = work.scaled(1 - dance.strength).forPose(rig: rigName, standing: posture.kind == .standing)
            pose.headX += work.headX; pose.headY += work.headY; pose.headAngle += work.headAngle
            let effect = motion.map { SpriteTransition.frame(kind: $0.kind, progress: progress, reduced: reduced, initialOpacity: $0.initialOpacity) } ?? TransitionFrame()
            pose.headY += effect.nod
            var target = NSRect(x: x + (width - 256 * factor) / 2, y: 36,
                                width: 256 * factor, height: 384 * factor * pose.bodyScaleY)
            target = target.insetBy(dx: target.width * (1 - effect.scaleX) / 2, dy: 0)
            target.origin.y += (posture.y + effect.y) * factor
            target.size.height *= posture.scaleY * effect.scaleY
            let opacity = posture.opacity * effect.opacity
            centers[character.id] = NSPoint(x: target.midX, y: target.minY + target.height * 0.48); colors[character.id] = accent
            if let motion, motion.initialOpacity == nil { SpriteTransition.drawBehind(target, kind: motion.kind, progress: progress, accent: accent, reduced: reduced) }
            SpriteDepth.drawContact(in: target, opacity: opacity)
            let scale = frame.width / max(1, bounds.width)
            let radius = 1 / max(0.25, factor * scale * (window?.backingScaleFactor ?? 2))
            NSGraphicsContext.saveGraphicsState(); MusicMotion.apply(dance, target: target)
            SpriteTransition.apply(angle: posture.angle + effect.angle + work.bodyAngle, in: target)
            if effect.reveal < 1 { NSBezierPath(rect: NSRect(x: target.minX, y: target.minY, width: target.width, height: target.height * effect.reveal)).addClip() }
            if let rig {
                rig.draw(in: target, pose: pose, time: time + Double(index) * 1.7,
                    gestureElapsed: gesture.map { time - $0 }, reduced: reduced,
                    opacity: opacity, radius: radius, faceRows: faceRows, sprites: sprites,
                    beatArm: dance.arm, beatHair: dance.hair, work: work, headRig: mixedHead)
            } else if let sourceHead = mixedHeadAtlas ?? headAtlas, let sourceBody = mixedBodyAtlas ?? bodyAtlas {
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
            NSGraphicsContext.restoreGraphicsState()
            if let motion, motion.initialOpacity == nil { SpriteTransition.drawFront(target, kind: motion.kind, progress: progress, accent: accent, seed: character.motionSeed, reduced: reduced) }
        }
        TeamMotion.draw(team.active(at: time), centers: centers, colors: colors, time: time, reduced: reduced)
        if onResize != nil && !characters.isEmpty {
            NSColor.secondaryLabelColor.withAlphaComponent(0.7).setStroke()
            let grip = NSBezierPath(); grip.lineWidth = 1
            for inset in [0.0, 4.0, 8.0] {
                grip.move(to: NSPoint(x: bounds.maxX - 14 + inset, y: 2))
                grip.line(to: NSPoint(x: bounds.maxX - 3, y: 13 - inset))
            }
            grip.stroke()
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
