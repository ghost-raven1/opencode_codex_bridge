import AppKit

/// A readable first beat completes before a short tool expires; ongoing tools repeat more slowly.
enum ActionMotion {
    static let kinds = ["read", "search", "edit", "test", "build", "run", "delegate"]
    static func title(_ kind: String?) -> String? {
        guard let kind else { return nil }
        return ["read": "Читает", "search": "Ищет", "edit": "Пишет", "test": "Тестирует",
                "build": "Собирает", "run": "Выполняет", "delegate": "Делегирует"][kind]
    }

    static func pose(rig: String, kind: String, time: Double, seed: UInt64) -> WorkPose {
        guard kinds.contains(kind), time.isFinite else { return WorkPose() }
        let elapsed = max(0, time), period = 3.8 + Double(seed % 7) * 0.1
        let p = elapsed < 1.2 ? elapsed / 1.2 : (elapsed - 1.2).truncatingRemainder(dividingBy: period) / period
        let beat = SkeletalGestures.ActionBeat(phase: p * 2 * .pi)
        let scan = beat.scan, tap = beat.tap, other = beat.other, press = beat.press
        var pose = WorkPose(clip: "\(rig)-\(kind)", bones: SkeletalGestures.action(role: rig, kind: kind, phase: p * 2 * .pi))
        let hand: String, support: String
        switch rig {
        case "designer": hand = "arm-left"; support = "arm-right"
        case "devops": hand = "tool-arm"; support = "hip-arm"
        case "tester": hand = "controller-arms"; support = "prop"
        default: hand = "arm-right"; support = "arm-left"
        }
        switch kind {
        case "read":
            pose.headX = scan * 1.7; pose.headY = -beat.ready * 1.1; pose.headAngle = scan * 0.8
            pose.joints = [hand: WorkJoint(angle: other * 1.8 - beat.prepare * 0.6), support: WorkJoint(angle: -scan * 0.3)]
            pose.joints["prop"] = WorkJoint(angle: scan * 0.25)
        case "search":
            pose.headX = scan * 1.9; pose.headY = -beat.ready * 0.7 + beat.confirm * 0.4
            pose.bodyAngle = scan * 0.7
            pose.joints = [hand: WorkJoint(angle: scan * 2.3, x: scan * 1.1), support: WorkJoint(angle: -scan * 0.7)]
        case "edit":
            pose.headY = -beat.ready; pose.bodyAngle = scan * 0.35
            pose.joints = [hand: WorkJoint(angle: tap * 2.1 - beat.prepare * 0.6, x: beat.trace * 0.9, y: tap * 1.3),
                           support: WorkJoint(angle: -other * 0.7, y: other * 0.5)]
        case "test":
            pose.headY = -press * 0.8 + beat.confirm * 0.8; pose.headAngle = scan * 0.9
            pose.joints = [hand: WorkJoint(angle: press * 2.4 - beat.prepare * 0.5, y: press * 1.4),
                           support: WorkJoint(angle: -scan * 0.4)]
        case "build":
            pose.headX = scan * 1.3; pose.headY = -beat.ready * 0.5 + beat.confirm * 0.8; pose.bodyAngle = scan * 0.6
            pose.joints = [hand: WorkJoint(angle: beat.ready * 1.6, y: beat.ready * 0.6), support: WorkJoint(angle: -scan * 0.5)]
            pose.joints["prop"] = WorkJoint(angle: scan * 0.35)
        case "run":
            pose.headY = -beat.ready * 0.6 + beat.confirm * 0.8
            pose.joints = [hand: WorkJoint(angle: press * 2.1 - beat.prepare * 0.8, y: press * 1.2),
                           support: WorkJoint(angle: -beat.confirm * 0.7)]
        case "delegate":
            pose.headX = scan * 1.8; pose.headAngle = scan * 1.2; pose.bodyAngle = scan * 0.8
            pose.joints = [hand: WorkJoint(angle: -beat.ready * 2.5 + beat.confirm * 0.5, y: beat.ready * 0.8),
                           support: WorkJoint(angle: -scan * 0.8)]
        default: break
        }
        if rig == "code", kind == "edit" {
            // Alternate the two keyboard hands; preserve their independent authored pivots.
            pose.joints = ["arm-left": WorkJoint(angle: other * 1.5, y: other * 1.3),
                           "arm-right": WorkJoint(angle: -tap * 1.5, y: tap * 1.3)]
        } else if rig == "designer", kind == "edit" {
            pose.joints[hand] = WorkJoint(angle: beat.trace * 2.4, x: beat.trace * 1.3, y: other * 0.7)
        } else if rig == "research", kind == "read" {
            pose.joints[hand] = WorkJoint(angle: other * 2.2, x: other * 0.8)
        } else if rig == "review", kind == "edit" || kind == "test" {
            pose.joints[hand] = WorkJoint(angle: press * 2.2, y: press)
        } else if rig == "devops", kind == "run" || kind == "build" {
            pose.joints[hand] = WorkJoint(angle: beat.trace * 1.8 + press * 0.4, y: press * 0.8)
        } else if rig == "tester", kind == "edit" || kind == "test" {
            pose.joints[hand] = WorkJoint(angle: (tap - other) * 1.5, y: max(tap, other) * 0.9)
        }
        return pose
    }
}
