import AppKit

/// Four unhurried rest gestures per role keep props attached to their driving hands.
enum IdleMotion {
    static func pose(rig: String, state: String, time: Double, gestureElapsed: Double?, variant: Int,
                     seed: Int, reduced: Bool) -> WorkPose {
        guard !reduced, time.isFinite else { return WorkPose() }
        let phase = time * 0.65 + Double(seed) * 1.7
        var rest = WorkPose(clip: "\(rig)-rest", bodyAngle: sin(phase) * 0.35)
        guard let elapsed = gestureElapsed, elapsed >= 0, elapsed < 4.8 else { return rest }
        let p = elapsed / 4.8, envelope = pow(sin(p * .pi), 2)
        let sweep = sin(p * 2 * .pi), nod = sin(p * 4 * .pi), kind = max(0, variant) % 4
        var pose = WorkPose(headX: kind == 1 ? sweep * 1.2 : 0,
                            headY: kind == 3 ? nod * 0.9 : -envelope * 0.4,
                            headAngle: sweep * (kind == 2 ? 1.2 : 0.6), bodyAngle: sweep * 0.7)
        switch rig {
        case "lead":
            pose.clip = ["tablet-rest", "team-glance", "jacket-settle", "calm-nod"][kind]
            pose.joints = ["arm-right": WorkJoint(angle: sweep * 1.6), "arm-left": WorkJoint(angle: -sweep * 0.7)]
        case "code":
            pose.clip = ["wrist-rest", "screen-glance", "headphones-settle", "relaxed-nod"][kind]
            pose.joints = ["arm-left": WorkJoint(angle: sweep * 0.9), "arm-right": WorkJoint(angle: -sweep * 1.2)]
        case "research":
            pose.clip = ["book-rest", "look-up", "bookmark-check", "reading-nod"][kind]
            pose.joints = ["arm-right": WorkJoint(angle: sweep * 1.3), "arm-left": WorkJoint(angle: -sweep * 0.4)]
        case "review":
            pose.clip = ["tablet-lower", "side-glance", "checklist-rest", "quiet-approval"][kind]
            pose.joints = ["arm-right": WorkJoint(angle: sweep * 1.7), "arm-left": WorkJoint(angle: -sweep * 0.5)]
        case "designer":
            pose.clip = ["stylus-rest", "palette-glance", "sketch-hover", "design-nod"][kind]
            pose.joints = ["arm-left": WorkJoint(angle: sweep * 1.4), "arm-right": WorkJoint(angle: -sweep * 0.6)]
        case "devops":
            pose.clip = ["meter-rest", "gauge-glance", "tool-settle", "ops-nod"][kind]
            pose.joints = ["tool-arm": WorkJoint(angle: sweep * 1.5), "hip-arm": WorkJoint(angle: -sweep * 0.5)]
        case "tester":
            pose.clip = ["controller-rest", "test-glance", "thumb-rest", "tester-nod"][kind]
            pose.joints = ["controller-arms": WorkJoint(angle: sweep * 1.1)]
        default: return rest
        }
        for (id, joint) in pose.joints {
            var adjusted = joint
            adjusted.angle *= kind == 2 ? 0.8 : kind == 0 ? 0.65 : 1
            adjusted.y = kind == 2 ? sin(p * 4 * .pi) * 0.4 : 0
            pose.joints[id] = adjusted
        }
        if ["waiting", "error"].contains(state) { pose.headAngle *= 0.5; pose.bodyAngle *= 0.5 }
        rest = rest.blending(pose, weight: envelope)
        return rest
    }
}
