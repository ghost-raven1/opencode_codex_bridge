import AppKit

/// Tool gestures use the existing joints and props; no full-body frame or extra render timer.
enum ActionMotion {
    static let kinds = ["read", "search", "edit", "test", "build", "run", "delegate"]
    static func title(_ kind: String?) -> String? {
        guard let kind else { return nil }
        return ["read": "Читает", "search": "Ищет", "edit": "Пишет", "test": "Тестирует",
                "build": "Собирает", "run": "Выполняет", "delegate": "Делегирует"][kind]
    }

    static func pose(rig: String, kind: String, time: Double, seed: UInt64) -> WorkPose {
        guard kinds.contains(kind), time.isFinite else { return WorkPose() }
        let p = (time + Double(seed % 991) / 101).truncatingRemainder(dividingBy: 6) / 6
        let scan = sin(p * 2 * .pi), tap = sin(p * 12 * .pi), other = sin(p * 12 * .pi + .pi / 2)
        let press = pow(max(0, sin((p - 0.05) * 2 * .pi)), 4)
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
            pose.headX = scan * 1.7; pose.headY = -1.1; pose.headAngle = scan * 0.8
            pose.joints = [hand: WorkJoint(angle: scan * 0.8), support: WorkJoint(angle: -scan * 0.3)]
            pose.joints["prop"] = WorkJoint(angle: scan * 0.25)
        case "search":
            pose.headX = scan * 1.9; pose.headY = -0.7 + cos(p * 4 * .pi) * 0.4
            pose.bodyAngle = scan * 0.7
            pose.joints = [hand: WorkJoint(angle: scan * 2.3, x: scan * 1.1), support: WorkJoint(angle: -scan * 0.7)]
        case "edit":
            pose.headY = -1.0; pose.bodyAngle = scan * 0.35
            pose.joints = [hand: WorkJoint(angle: tap * 1.8, x: scan * 0.9, y: tap * 1.3),
                           support: WorkJoint(angle: -other * 1.2, y: other * 0.9)]
        case "test":
            pose.headY = -0.8 + sin(p * 4 * .pi) * 0.8; pose.headAngle = scan * 0.9
            pose.joints = [hand: WorkJoint(angle: press * 2.4, y: press * 1.4), support: WorkJoint(angle: -scan * 0.4)]
        case "build":
            pose.headX = scan * 1.3; pose.headY = cos(p * 4 * .pi) * 0.8; pose.bodyAngle = scan * 0.6
            pose.joints = [hand: WorkJoint(angle: scan * 1.1), support: WorkJoint(angle: -scan * 0.5)]
            pose.joints["prop"] = WorkJoint(angle: scan * 0.35)
        case "run":
            pose.headY = -0.6 + sin(p * 4 * .pi) * 0.5
            pose.joints = [hand: WorkJoint(angle: press * 2.1, y: press * 1.2), support: WorkJoint(angle: -scan * 0.7)]
        case "delegate":
            pose.headX = scan * 1.8; pose.headAngle = scan * 1.2; pose.bodyAngle = scan * 0.8
            pose.joints = [hand: WorkJoint(angle: scan * 2.5, y: scan * 0.8), support: WorkJoint(angle: -scan * 0.8)]
        default: break
        }
        if rig == "code", kind == "edit" {
            // Alternate the two keyboard hands; preserve their independent authored pivots.
            pose.joints = ["arm-left": WorkJoint(angle: tap * 1.5, y: tap * 1.3),
                           "arm-right": WorkJoint(angle: -other * 1.5, y: other * 1.3)]
        }
        return pose
    }
}
