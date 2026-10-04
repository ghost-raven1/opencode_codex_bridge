import AppKit

struct StateFrame {
    var pose = WorkPose()
    var weight: CGFloat = 0
}

/// State reactions use authored joints; no new bitmaps, timers or motion during Reduce Motion.
enum StateMotion {
    static let kinds = ["thinking", "waiting", "success", "error"]
    static func frame(rig: String, state: String, elapsed: Double, seed: UInt64, reduced: Bool) -> StateFrame {
        let roles = CompanionRig.names
        guard !reduced, elapsed.isFinite, elapsed >= 0, let role = roles.firstIndex(of: rig), kinds.contains(state) else { return StateFrame() }
        let hand = rig == "designer" ? "arm-left" : rig == "devops" ? "tool-arm" : rig == "tester" ? "controller-arms" : "arm-right"
        let support = rig == "designer" ? "arm-right" : rig == "devops" ? "hip-arm" : rig == "tester" ? "prop" : "arm-left"
        let phase = elapsed * 2 * .pi / (5.4 + Double(role) * 0.18) + Double(seed % 97) / 97
        let scan = sin(phase), nod = sin(phase * 2)
        var pose = WorkPose(clip: "\(rig)-\(state)"), weight: Double
        switch state {
        case "thinking":
            weight = 0.65
            pose.headX = scan * 1.1; pose.headY = -0.4 + nod * 0.4
            pose.headAngle = scan * 1.8; pose.bodyAngle = -scan * 0.4
            pose.joints = [hand: WorkJoint(angle: scan * 1.5, y: nod * 0.6), support: WorkJoint(angle: -scan * 0.4)]
            pose.bones = SkeletalGestures.reaction(role: rig, state: state, scan: scan, nod: nod, amount: 0)
        case "waiting":
            // A visible request on entry, then a slow reminder rather than a frozen work pose.
            let cycle = elapsed.truncatingRemainder(dividingBy: 8)
            let offer = cycle < 3.2 ? pow(sin(cycle / 3.2 * .pi), 2) : 0
            weight = 0.45 + offer * 0.45
            pose.headX = scan * 0.7; pose.headAngle = -0.7 - offer * 1.2; pose.bodyAngle = offer * 0.6
            pose.joints = [hand: WorkJoint(angle: offer * 2.4, y: offer * 1.2), support: WorkJoint(angle: -offer * 0.5)]
            pose.bones = SkeletalGestures.reaction(role: rig, state: state, scan: scan, nod: nod, amount: offer)
        case "success":
            guard elapsed < 3 else { return StateFrame() }
            let p = elapsed / 3, envelope = pow(sin(p * .pi), 2)
            weight = envelope * 0.9
            pose.headY = sin(p * 4 * .pi) * 1.1; pose.headAngle = sin(p * 2 * .pi) * 0.7
            pose.bodyAngle = -sin(p * 2 * .pi) * 0.8
            pose.joints = [hand: WorkJoint(angle: sin(p * .pi) * 2.3, y: envelope), support: WorkJoint(angle: -envelope * 0.7)]
            pose.bones = SkeletalGestures.reaction(role: rig, state: state, scan: sin(p * 2 * .pi), nod: sin(p * 4 * .pi), amount: envelope)
        case "error":
            guard elapsed < 3.6 else { return StateFrame() }
            let p = elapsed / 3.6, envelope = pow(sin(p * .pi), 2)
            weight = envelope * 0.85
            pose.headAngle = sin(p * 6 * .pi) * 1.8; pose.headY = -envelope * 1.2
            pose.headX = sin(p * 2 * .pi) * 0.8; pose.bodyAngle = envelope * 0.5
            pose.joints = [hand: WorkJoint(angle: -envelope * 1.6, y: -envelope * 0.8), support: WorkJoint(angle: envelope * 0.5)]
            pose.bones = SkeletalGestures.reaction(role: rig, state: state, scan: sin(p * 2 * .pi), nod: sin(p * 6 * .pi), amount: envelope)
        default: return StateFrame()
        }
        return StateFrame(pose: pose.scaled(CGFloat(0.8 + Double(role) * 0.03)), weight: CGFloat(weight))
    }
}

/// Input/ticks own reaction time. Terminal gestures pause during narration and resume afterwards.
struct StateAnimation {
    private let seed: UInt64
    private var state = ""
    private var invocation: String?
    private var startedAt = 0.0
    private var pausedAt: Double?
    private var previous: [String: StateFrame] = [:]

    init(seed: String) {
        self.seed = seed.utf8.reduce(UInt64(14695981039346656037)) { ($0 ^ UInt64($1)) &* 1099511628211 }
    }

    mutating func update(state: String, at time: Double, invocation: String?, speaking: Bool) {
        guard time.isFinite else { return }
        if self.state != state || self.invocation != invocation {
            previous = self.invocation == invocation && !self.state.isEmpty
                ? Dictionary(uniqueKeysWithValues: CompanionRig.names.map { ($0, frame(rig: $0, at: time, reduced: false)) }) : [:]
            self.state = state; self.invocation = invocation; startedAt = time; pausedAt = nil
        }
        if speaking && ["success", "error"].contains(state) {
            if pausedAt == nil { pausedAt = time }
        } else if let pause = pausedAt {
            startedAt += max(0, time - pause); pausedAt = nil
        }
    }

    func frame(rig: String, at time: Double, reduced: Bool) -> StateFrame {
        guard !reduced, time.isFinite else { return StateFrame() }
        let elapsed = max(0, (pausedAt ?? time) - startedAt)
        let target = StateMotion.frame(rig: rig, state: state, elapsed: elapsed, seed: seed, reduced: reduced)
        let t = CGFloat(min(1, elapsed / 0.35)), blend = t * t * (3 - 2 * t)
        let old = previous[rig] ?? StateFrame()
        let weight = old.weight * (1 - blend) + target.weight * blend
        guard weight > 0 else { return StateFrame() }
        return StateFrame(pose: old.pose.blending(target.pose, weight: target.weight * blend / weight), weight: weight)
    }
}
