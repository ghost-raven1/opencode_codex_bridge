import AppKit

enum TeamActionKind: String {
    case greeting, handoff, result, support
    var duration: Double { self == .handoff || self == .result ? 2.8 : 2.4 }
}

struct TeamAction {
    let kind: TeamActionKind
    let source: String
    let target: String
    let start: Double
    var end: Double { start + kind.duration }
    func contains(_ id: String) -> Bool { source == id || target == id }
    func progress(at time: Double) -> Double { min(1, max(0, (time - start) / kind.duration)) }
}

/// Real parent/child links drive handoffs. One participant never performs two actions at once.
struct TeamCoordinator {
    private struct Member {
        var character: Character
        var handedOff = false
        var reactions = Set<String>()
    }
    private var members: [String: Member] = [:]
    private var archived: [String: Member] = [:]
    private(set) var actions: [TeamAction] = []

    mutating func observe(_ character: Character, at time: Double, entranceDelay: Double = 0, animated: Bool = true) {
        guard time.isFinite else { return }
        tick(at: time)
        let old = members[character.id] ?? archived.removeValue(forKey: character.id)
        let newInvocation = old != nil && old?.character.invocationID != character.invocationID
        if newInvocation { actions.removeAll { $0.contains(character.id) } }
        var member = newInvocation ? Member(character: character) : old ?? Member(character: character)
        member.character = character; members[character.id] = member
        if animated, old == nil, character.parentID == nil,
           let peer = members.keys.filter({ $0 != character.id }).sorted().first {
            enqueue(.greeting, source: peer, target: character.id, at: time + entranceDelay)
        }
        // Metadata and the parent's first appearance can arrive in either order.
        for id in members.keys.sorted() {
            guard var child = members[id], let parent = child.character.parentID, parent != id,
                  members[parent] != nil else { continue }
            if !child.handedOff, ["working", "thinking", "waiting"].contains(child.character.state) {
                if animated { enqueue(.handoff, source: parent, target: id, at: time + entranceDelay) }
                child.handedOff = true
            }
            if ["success", "error"].contains(child.character.state), !child.reactions.contains(child.character.state) {
                let failed = child.character.state == "error"
                if animated { enqueue(failed ? .support : .result, source: failed ? parent : id,
                        target: failed ? id : parent, at: time + entranceDelay) }
                child.reactions.insert(child.character.state)
            }
            members[id] = child
        }
        if animated, character.parentID == nil, old?.character.state != character.state,
           ["success", "error"].contains(character.state), !member.reactions.contains(character.state),
           let peer = members.keys.filter({ $0 != character.id && members[$0]?.character.parentID == character.id }).sorted().first {
            let failed = character.state == "error"
            enqueue(failed ? .support : .result, source: failed ? peer : character.id,
                    target: failed ? character.id : peer, at: time + entranceDelay)
            members[character.id]?.reactions.insert(character.state)
        }
    }

    private mutating func enqueue(_ kind: TeamActionKind, source: String, target: String, at time: Double) {
        guard source != target, actions.count < 8 else { return }
        let last = actions.filter { $0.contains(source) || $0.contains(target) }.map(\.end).max() ?? time
        let start = max(time, last + 0.12)
        guard start - time <= 6 else { return }
        actions.append(TeamAction(kind: kind, source: source, target: target, start: start))
    }

    mutating func tick(at time: Double) { actions.removeAll { $0.end <= time } }
    mutating func remove(_ id: String) {
        if let member = members.removeValue(forKey: id) {
            if archived.count >= 64, let first = archived.keys.first { archived[first] = nil }
            archived[id] = member
        }
        actions.removeAll { $0.contains(id) }
    }
    mutating func reset() { members = [:]; archived = [:]; actions = [] }
    func active(at time: Double) -> [TeamAction] { actions.filter { $0.start <= time && time < $0.end } }
    func action(for id: String, at time: Double) -> TeamAction? { active(at: time).first { $0.contains(id) } }
}

enum TeamMotion {
    /// Look, offer, receive and acknowledge share one timeline, with role-specific hands.
    static func pose(_ action: TeamAction, id: String, rig: String, direction: Double, at time: Double, reduced: Bool) -> WorkPose {
        guard !reduced else { return WorkPose() }
        let p = action.progress(at: time), envelope = pow(sin(p * .pi), 2)
        let receiving = id == action.target
        let acknowledgement = sin(max(0, (p - 0.45) / 0.55) * 2 * .pi)
        let wave = sin(p * 6 * .pi), offer = sin(p * .pi)
        let hand = action.kind == .greeting ? wave : action.kind == .result ? sin(p * 4 * .pi) : offer * (receiving ? -1 : 1) * (action.kind == .support ? 0.45 : 1)
        var pose = WorkPose(clip: "team-\(action.kind.rawValue)", headX: direction * 0.8,
                            headY: receiving ? acknowledgement * 0.8 : -0.3,
                            headAngle: -direction * 0.7, bodyAngle: -direction * 0.8)
        if action.kind == .result { pose.headY = sin(p * 4 * .pi) * 0.8; pose.bodyAngle = -direction * sin(p * .pi) * 0.7 }
        if action.kind == .support { pose.headY = -offer * 0.4; pose.bodyAngle *= 0.75 }
        switch rig {
        case "lead", "research", "review":
            pose.joints = ["arm-right": WorkJoint(angle: hand * 2), "arm-left": WorkJoint(angle: -offer * 0.5),
                           "prop": WorkJoint(angle: offer * 0.3)]
        case "code":
            pose.joints = ["arm-right": WorkJoint(angle: hand * 1.3), "arm-left": WorkJoint(angle: -offer * 0.7)]
        case "designer":
            pose.joints = ["arm-left": WorkJoint(angle: hand * 1.8), "arm-right": WorkJoint(angle: -offer * 0.5)]
        case "devops":
            pose.joints = ["tool-arm": WorkJoint(angle: hand * 1.7), "hip-arm": WorkJoint(angle: -offer * 0.5)]
        case "tester": pose.joints = ["controller-arms": WorkJoint(angle: hand * 1.2)]
        default: break
        }
        return pose.scaled(envelope)
    }

    static func face(_ action: TeamAction, id: String, at time: Double) -> Int? {
        guard action.progress(at: time) > 0.15 else { return nil }
        if action.kind == .support { return 15 }
        if action.kind == .greeting || action.progress(at: time) > 0.65 { return 14 }
        return nil
    }

    /// Small packets live between colleagues rather than covering faces or terminal text.
    static func draw(_ actions: [TeamAction], centers: [String: NSPoint], colors: [String: NSColor], time: Double, reduced: Bool) {
        guard !reduced else { return }
        for action in actions {
            guard let a = centers[action.source], let b = centers[action.target] else { continue }
            let p = action.progress(at: time), alpha = pow(sin(p * .pi), 2)
            let color = colors[action.source] ?? .systemTeal
            if action.kind == .greeting || action.kind == .support {
                let icon = action.kind == .support ? ["01010", "11111", "11111", "01110", "00100"] : ["00100", "01010", "10001"]
                let side: CGFloat = b.x > a.x ? 1 : -1
                for center in [NSPoint(x: a.x + side * 50, y: a.y), NSPoint(x: b.x - side * 50, y: b.y)] {
                    color.withAlphaComponent(alpha * 0.7).setFill()
                    for (y, row) in icon.enumerated() { for (x, bit) in row.enumerated() where bit == "1" {
                        NSBezierPath(rect: NSRect(x: center.x - 5 + CGFloat(x * 2), y: center.y + 28 + CGFloat((icon.count - y) * 2), width: 2, height: 2)).fill()
                    } }
                }
                continue
            }
            let t = min(1, max(0, (p - 0.22) / 0.56)), smooth = t * t * (3 - 2 * t)
            let x = a.x + (b.x - a.x) * smooth, y = a.y + (b.y - a.y) * smooth + 20 * sin(t * .pi)
            for n in 1...4 {
                let tail = max(0, t - Double(n) * 0.035)
                color.withAlphaComponent(alpha * (0.25 - Double(n) * 0.04)).setFill()
                NSRect(x: a.x + (b.x - a.x) * tail, y: a.y + (b.y - a.y) * tail + 20 * sin(tail * .pi), width: 2, height: 2).fill()
            }
            color.withAlphaComponent(alpha * 0.85).setFill()
            let card = NSRect(x: x.rounded() - 4, y: y.rounded() - 4, width: 8, height: 8)
            NSBezierPath(roundedRect: card, xRadius: 1, yRadius: 1).fill()
            NSColor.white.withAlphaComponent(alpha * 0.8).setStroke()
            let mark = NSBezierPath(); mark.lineWidth = 1
            if action.kind == .result {
                mark.move(to: NSPoint(x: x - 2, y: y)); mark.line(to: NSPoint(x: x, y: y - 2)); mark.line(to: NSPoint(x: x + 3, y: y + 2))
            } else { mark.move(to: NSPoint(x: x - 2, y: y + 1)); mark.line(to: NSPoint(x: x + 2, y: y + 1)) }
            mark.stroke()
        }
    }
}
