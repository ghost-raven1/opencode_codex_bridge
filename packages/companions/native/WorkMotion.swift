import AppKit

/// Joint offsets are in source pixels/degrees; the rig applies its own authored joint limits.
struct WorkJoint {
    var angle: CGFloat = 0
    var x: CGFloat = 0
    var y: CGFloat = 0
    func scaled(_ weight: CGFloat) -> WorkJoint { WorkJoint(angle: angle * weight, x: x * weight, y: y * weight) }
}

struct WorkPose {
    var clip = "rest"
    var joints: [String: WorkJoint] = [:]
    var headX: CGFloat = 0
    var headY: CGFloat = 0
    func scaled(_ weight: CGFloat) -> WorkPose {
        WorkPose(clip: clip, joints: joints.mapValues { $0.scaled(weight) }, headX: headX * weight, headY: headY * weight)
    }

    /// Crossfade gestures over the ongoing work loop without adding joint amplitudes.
    func blending(_ other: WorkPose, weight: CGFloat) -> WorkPose {
        var result = scaled(1 - weight)
        for (id, joint) in other.joints {
            let old = result.joints[id] ?? WorkJoint(), next = joint.scaled(weight)
            result.joints[id] = WorkJoint(angle: old.angle + next.angle, x: old.x + next.x, y: old.y + next.y)
        }
        result.clip = other.clip
        result.headX += other.headX * weight; result.headY += other.headY * weight
        return result
    }
}

/// A continuous role-specific work loop carries occasional gestures and soft state changes.
struct WorkAnimation {
    private let seed: UInt64
    private var active = false
    private var changedAt = -Double.infinity
    private var initialWeight: CGFloat = 0

    init(seed: String) {
        self.seed = seed.utf8.reduce(UInt64(14695981039346656037)) { ($0 ^ UInt64($1)) &* 1099511628211 }
    }

    mutating func update(active: Bool, at time: Double) {
        guard active != self.active else { return }
        initialWeight = weight(at: time); changedAt = time; self.active = active
    }

    private func weight(at time: Double) -> CGFloat {
        let t = min(1, max(0, (time - changedAt) / 0.3))
        let eased = t * t * (3 - 2 * t)
        return initialWeight + ((active ? 1 : 0) - initialWeight) * eased
    }

    func pose(rig: String, at time: Double, reduced: Bool) -> WorkPose {
        guard !reduced, time.isFinite, weight(at: time) > 0 else { return WorkPose() }
        let period = 8.2 + Double(seed % 31) / 10
        let phase = max(0, time + Double(seed % 997) / 97)
        let cycle = Int(phase / period), elapsed = phase.truncatingRemainder(dividingBy: period)
        let focus = focusPose(rig: rig, phase: phase)
        let duration = 4.2
        guard elapsed < duration else { return focus.scaled(weight(at: time)) }
        let p = elapsed / duration, envelope = pow(sin(p * .pi), 2)
        let sweep = sin(p * 2 * .pi), taps = sin(p * 12 * .pi)
        let alternate = (cycle + Int(seed % 2)) % 2 == 1
        var pose = WorkPose(headY: -0.7)
        switch rig {
        case "lead":
            pose.clip = alternate ? "tablet-swipe" : "tablet-tap"
            pose.joints = ["arm-right": WorkJoint(angle: alternate ? sweep * 2.1 : taps * 1.4, x: alternate ? sweep * 1.3 : 0, y: alternate ? 0 : taps * 0.7),
                           "arm-left": WorkJoint(angle: -0.5 * sweep), "prop": WorkJoint(angle: 0.35 * sweep)]
        case "code":
            pose.clip = alternate ? "keyboard-right" : "keyboard-left"
            let left = sin(p * 16 * .pi), right = sin(p * 16 * .pi + .pi / 2)
            pose.joints = ["arm-left": WorkJoint(angle: left * 0.9, y: left * (alternate ? 0.65 : 1.1)),
                           "arm-right": WorkJoint(angle: -right * 0.9, y: right * (alternate ? 1.1 : 0.65)),
                           "prop": WorkJoint(y: 0.12 * sweep)]
        case "research":
            pose.clip = alternate ? "page-turn" : "read-line"
            pose.joints = ["arm-right": WorkJoint(angle: alternate ? sweep * 2.7 : 0.6 * sweep, x: alternate ? 1.2 * sweep : 0),
                           "arm-left": WorkJoint(angle: -0.5 * sweep), "prop": WorkJoint(angle: alternate ? 0.6 * sweep : 0.25 * sweep)]
            pose.headX = alternate ? 0 : sweep * 0.8
        case "review":
            pose.clip = alternate ? "checklist-mark" : "tablet-inspect"
            pose.joints = ["arm-right": WorkJoint(angle: alternate ? taps * 1.6 : sweep * 1.1, y: alternate ? taps * 0.8 : 0),
                           "arm-left": WorkJoint(angle: -sweep * 0.5), "prop": WorkJoint(angle: sweep * 0.4)]
        case "designer":
            pose.clip = alternate ? "stylus-sketch" : "palette-check"
            pose.joints = ["arm-left": WorkJoint(angle: alternate ? taps * 1.4 : sweep * 0.5, x: alternate ? sweep : 0),
                           "arm-right": WorkJoint(angle: alternate ? sweep * 0.4 : sweep * 1.8)]
        case "devops":
            pose.clip = alternate ? "meter-check" : "probe-adjust"
            pose.joints = ["tool-arm": WorkJoint(angle: sweep * (alternate ? 1.7 : 1.2), y: alternate ? taps * 0.5 : 0),
                           "hip-arm": WorkJoint(angle: sweep * 0.4)]
        case "tester":
            pose.clip = alternate ? "controller-test" : "controller-combo"
            pose.joints = ["controller-arms": WorkJoint(angle: sweep * (alternate ? 0.8 : 1.3),
                                                        y: sin(p * (alternate ? 16 : 10) * .pi) * 0.7)]
        default: return WorkPose()
        }
        return focus.blending(pose, weight: envelope).scaled(weight(at: time))
    }

    private func focusPose(rig: String, phase: Double) -> WorkPose {
        let p = phase * 2 * .pi / (3.4 + Double(seed % 13) / 10)
        let sweep = sin(p), tap = sin(p * 4), other = sin(p * 4 + .pi / 2)
        var pose = WorkPose(clip: "\(rig)-focus", headY: -0.4 + 0.25 * cos(p))
        switch rig {
        case "lead":
            pose.joints = ["arm-right": WorkJoint(angle: tap * 0.9, y: tap * 0.7),
                           "arm-left": WorkJoint(angle: sweep * 0.4), "prop": WorkJoint(angle: sweep * 0.3)]
            pose.headX = sweep * 0.6
        case "code":
            pose.joints = ["arm-left": WorkJoint(angle: tap * 1.1, y: tap * 1.0),
                           "arm-right": WorkJoint(angle: -other * 1.1, y: other * 1.0)]
        case "research", "review":
            pose.joints = ["arm-right": WorkJoint(angle: sweep * 0.9, y: cos(p) * 0.5),
                           "arm-left": WorkJoint(angle: -sweep * 0.5), "prop": WorkJoint(angle: sweep * 0.45)]
            pose.headX = sweep * 1.1
        case "designer":
            pose.joints = ["arm-left": WorkJoint(angle: tap * 1.0, x: sweep * 0.8),
                           "arm-right": WorkJoint(angle: sweep * 0.6)]
        case "devops":
            pose.joints = ["tool-arm": WorkJoint(angle: sweep * 1.2, y: tap * 0.6),
                           "hip-arm": WorkJoint(angle: -sweep * 0.4)]
            pose.headX = sweep * 0.6
        case "tester":
            pose.joints = ["controller-arms": WorkJoint(angle: sweep * 0.7, y: tap * 0.8)]
        default: return WorkPose()
        }
        return pose
    }
}
