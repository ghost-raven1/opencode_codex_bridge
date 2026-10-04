import AppKit

/// Existing action gestures drive a full joint hierarchy; feet are solved in bind-space, not rotated with the sprite.
enum SkeletalMotion {
    static func offsets(rig: SkeletalRig, role: String, posture: String, time: Double, seed: Int,
                        head: LayerPose, work: WorkPose, music: MusicPose, beat: MusicBeatState?,
                        speaking: Bool, reduced: Bool, walkPhase: Double? = nil,
                        transitionAngle: Double = 0) -> [String: BoneOffset] {
        guard !reduced, time.isFinite else { return [:] }
        let music = speaking ? MusicPose() : music
        let index = CompanionRig.names.firstIndex(of: role) ?? 0
        let phase = time * (0.65 + Double(index) * 0.025) + Double(seed % 97) / 13
        let walking = posture == "walk-left" || posture == "walk-right"
        let resting = posture == "seated" || posture == "reclining"
        var pose: [String: BoneOffset] = [
            "pelvis": BoneOffset(angle: -work.bodyAngle - music.angle * 0.22 - transitionAngle,
                                  x: (sin(phase) * 0.55 + music.x * 0.2) * (resting ? 0.2 : 1),
                                  y: resting ? 0 : 0.9 + cos(phase) * 0.3 + abs(music.y) * 0.45),
            "spine": BoneOffset(angle: sin(phase) * 0.18),
            "chest": BoneOffset(angle: -sin(phase) * 0.12, y: -Double(head.bodyScaleY - 1) * 80),
            "neck": BoneOffset(x: head.headX, y: -head.headY),
            "head": BoneOffset(angle: -head.headAngle),
        ]
        let hands: [String: String] = role == "devops" ? ["left": "hip-arm", "right": "tool-arm"]
            : role == "tester" ? ["left": "controller-arms", "right": "controller-arms"]
            : ["left": "arm-left", "right": "arm-right"]
        for side in ["left", "right"] {
            let joint = work.joints[hands[side]!] ?? WorkJoint()
            let direction = side == "left" ? -1.0 : 1.0
            let angle = joint.angle + music.arm * direction * 2
            pose["upper-arm-\(side)"] = BoneOffset(angle: -angle * 0.35)
            pose["forearm-\(side)"] = BoneOffset(angle: -angle * 0.65)
        }
        if let prop = work.joints["prop"] { pose["prop"] = BoneOffset(angle: -prop.angle, x: prop.x, y: -prop.y) }
        for (id, offset) in work.bones {
            pose[id] = (pose[id] ?? BoneOffset()).adding(offset.scaled(resting && id == "pelvis" ? 0.2 : 1))
        }
        let gait = walkPhase.flatMap { $0.isFinite ? $0 : nil } ?? 0
        var dancePhase = 0.0
        if let beat, beat.period > 0 { dancePhase = (time - beat.anchor) / beat.period * .pi + Double(beat.sequence) * .pi }
        if music.strength > 0, !speaking {
            for (id, offset) in SkeletalGestures.dance(role: role, phase: dancePhase) {
                pose[id] = (pose[id] ?? BoneOffset()).adding(offset.scaled(music.strength * (resting && id == "pelvis" ? 0.2 : 1)))
            }
        }
        var feet: [String: BoneOffset] = [:]
        for side in ["left", "right"] {
            let p = side == "left" ? 0.0 : .pi
            if walking {
                let swing = pow(max(0, sin(gait + p)), 2)
                feet[side] = BoneOffset(angle: swing * 2, x: swing * cos(gait + p) * 2.5, y: -swing * 4)
            } else if music.strength > 0, !speaking, !resting {
                feet[side] = danceFoot(role: role, phase: dancePhase + p).scaled(music.strength)
            } else { feet[side] = BoneOffset() }
        }
        keepReachable(rig: rig, feet: feet, pose: &pose)
        for side in ["left", "right"] {
            let joint = work.joints[hands[side]!] ?? WorkJoint()
            if joint.x != 0 || joint.y != 0 {
                let endpoint = "hand-\(side)", matrix = rig.transforms(pose)
                let hand = matrix[endpoint]!.point(rig.bones[endpoint]!.point)
                solveLimb(rig: rig, root: "upper-arm-\(side)", middle: "forearm-\(side)", end: endpoint,
                    target: CGPoint(x: hand.x + joint.x, y: hand.y - joint.y), endAngle: nil, pose: &pose)
            }
            let foot = feet[side]!
            solveLeg(rig: rig, side: side, targetOffset: CGPoint(x: foot.x, y: foot.y), footAngle: foot.angle, pose: &pose)
        }
        return pose
    }

    /// Two-bone IK preserves authored lengths and the knee's bend direction; the ankle follows the support/swing target.
    static func solveLeg(rig: SkeletalRig, side: String, targetOffset: CGPoint, footAngle: Double,
                         pose: inout [String: BoneOffset]) {
        let thighID = "thigh-\(side)", shinID = "shin-\(side)", footID = "foot-\(side)"
        guard let foot = rig.bones[footID] else { return }
        solveLimb(rig: rig, root: thighID, middle: shinID, end: footID,
            target: CGPoint(x: foot.point.x + targetOffset.x, y: foot.point.y + targetOffset.y), endAngle: footAngle, pose: &pose)
    }

    /// Hand translations become IK targets too: elbow/wrist spacing never stretches with a tool gesture.
    private static func solveLimb(rig: SkeletalRig, root: String, middle: String, end: String,
                                  target ankle: CGPoint, endAngle: Double?, pose: inout [String: BoneOffset]) {
        guard let thigh = rig.bones[root], let shin = rig.bones[middle], let foot = rig.bones[end] else { return }
        let matrices = rig.transforms(pose), parent = thigh.parent.flatMap { matrices[$0] } ?? BoneTransform()
        let hip = parent.point(thigh.point)
        let l1 = hypot(shin.point.x - thigh.point.x, shin.point.y - thigh.point.y)
        let l2 = hypot(foot.point.x - shin.point.x, foot.point.y - shin.point.y)
        guard l1 > 0.01, l2 > 0.01 else { return }
        let dx = ankle.x - hip.x, dy = ankle.y - hip.y, raw = hypot(dx, dy)
        guard raw > 0.01 else { return }
        let distance = min(l1 + l2 - 0.00001, max(abs(l1 - l2) + 0.00001, raw))
        let along = (l1 * l1 - l2 * l2 + distance * distance) / (2 * distance)
        let perpendicular = sqrt(max(0, l1 * l1 - along * along))
        let cross = (shin.point.x - thigh.point.x) * (foot.point.y - shin.point.y)
            - (shin.point.y - thigh.point.y) * (foot.point.x - shin.point.x)
        let bend = cross < 0 ? 1.0 : -1.0
        let knee = CGPoint(x: hip.x + dx / raw * along - dy / raw * perpendicular * bend,
                           y: hip.y + dy / raw * along + dx / raw * perpendicular * bend)
        let upper = atan2(knee.y - hip.y, knee.x - hip.x) * 180 / .pi
        let lower = atan2(ankle.y - knee.y, ankle.x - knee.x) * 180 / .pi
        let bindUpper = atan2(shin.point.y - thigh.point.y, shin.point.x - thigh.point.x) * 180 / .pi
        let bindLower = atan2(foot.point.y - shin.point.y, foot.point.x - shin.point.x) * 180 / .pi
        pose[root] = BoneOffset(angle: wrapped(upper - bindUpper - parent.angle))
        pose[middle] = BoneOffset(angle: wrapped(lower - bindLower - upper + bindUpper))
        // Counter-rotation keeps a planted shoe flat, including inherited pelvis rotation.
        if let endAngle {
            let current = rig.transforms(pose)
            pose[end] = BoneOffset(angle: wrapped(endAngle - (current[middle]?.angle ?? 0)))
        }
    }

    /// Lower the pelvis just enough to keep both support targets reachable while the torso leans.
    private static func keepReachable(rig: SkeletalRig, feet: [String: BoneOffset], pose: inout [String: BoneOffset]) {
        let matrices = rig.transforms(pose)
        var down = 0.0
        for side in ["left", "right"] {
            let a = rig.bones["thigh-\(side)"]!.point, b = rig.bones["shin-\(side)"]!.point, c = rig.bones["foot-\(side)"]!.point
            let hip = matrices["pelvis"]!.point(a), target = feet[side]!
            let length = hypot(b.x - a.x, b.y - a.y) + hypot(c.x - b.x, c.y - b.y) - 0.0001
            let vertical = sqrt(max(0, length * length - pow(c.x + target.x - hip.x, 2)))
            down = max(down, c.y + target.y - hip.y - vertical)
        }
        pose["pelvis"]?.y += down
    }

    private static func danceFoot(role: String, phase: Double) -> BoneOffset {
        let pulse = max(0, sin(phase)), swing = pulse * pulse, drift = swing * cos(phase)
        switch role {
        case "code": return BoneOffset(angle: swing * 3, x: drift * 1.2, y: -swing * 3)
        case "research": return BoneOffset(angle: swing, x: drift * 0.6, y: -swing * 1.2)
        case "review": return BoneOffset(angle: swing * 2.5, x: -drift * 0.4, y: -swing * 1.7)
        case "designer": return BoneOffset(angle: swing * 4, x: drift * 1.3, y: -swing * 2.2)
        case "devops": return BoneOffset(angle: pow(pulse, 3) * 2, x: drift * 0.75, y: -pow(pulse, 3) * 3.2)
        case "tester": return BoneOffset(angle: pulse * 3, x: drift, y: -pow(pulse, 1.5) * 2.5)
        default: return BoneOffset(angle: swing * 1.5, x: drift * 0.7, y: -swing * 1.8)
        }
    }

    private static func wrapped(_ angle: Double) -> Double {
        var value = angle.truncatingRemainder(dividingBy: 360)
        if value > 180 { value -= 360 }; if value < -180 { value += 360 }
        return value
    }
}
