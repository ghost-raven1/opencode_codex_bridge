import AppKit

/// Existing action gestures drive a full joint hierarchy; feet are solved in bind-space, not rotated with the sprite.
enum SkeletalMotion {
    static func offsets(rig: SkeletalRig, role: String, posture: String, time: Double, seed: Int,
                        head: LayerPose, work: WorkPose, music: MusicPose, beat: MusicBeatState?,
                        speaking: Bool, reduced: Bool) -> [String: BoneOffset] {
        guard !reduced, time.isFinite else { return [:] }
        let index = CompanionRig.names.firstIndex(of: role) ?? 0
        let phase = time * (0.65 + Double(index) * 0.025) + Double(seed % 97) / 13
        let walking = posture == "walk-left" || posture == "walk-right"
        var pose: [String: BoneOffset] = [
            "pelvis": BoneOffset(angle: -work.bodyAngle - music.angle * 0.22,
                                  x: sin(phase) * 0.55 + music.x * 0.2,
                                  y: 0.9 + cos(phase) * 0.3 + abs(music.y) * 0.45),
            "spine": BoneOffset(angle: sin(phase) * 0.18),
            "chest": BoneOffset(angle: -sin(phase) * 0.12),
            "head": BoneOffset(angle: -head.headAngle, x: head.headX, y: -head.headY),
        ]
        let hands: [String: String] = role == "devops" ? ["left": "hip-arm", "right": "tool-arm"]
            : role == "tester" ? ["left": "controller-arms", "right": "controller-arms"]
            : ["left": "arm-left", "right": "arm-right"]
        for side in ["left", "right"] {
            let joint = work.joints[hands[side]!] ?? WorkJoint()
            let direction = side == "left" ? -1.0 : 1.0
            let angle = joint.angle + music.arm * direction * 2
            pose["upper-arm-\(side)"] = BoneOffset(angle: -angle * 0.35)
            pose["forearm-\(side)"] = BoneOffset(angle: -angle * 0.65,
                x: joint.x * 0.35, y: -joint.y * 0.35)
            pose["hand-\(side)"] = BoneOffset(x: joint.x * 0.65, y: -joint.y * 0.65)
        }
        if let prop = work.joints["prop"] { pose["prop"] = BoneOffset(angle: -prop.angle, x: prop.x, y: -prop.y) }
        let gait = time * 2 * .pi / ChoreographyClips.standard.walk.stepSeconds
        var dancePhase = 0.0
        if let beat, beat.period > 0 { dancePhase = (time - beat.anchor) / beat.period * .pi + Double(beat.sequence) * .pi }
        for side in ["left", "right"] {
            let p = side == "left" ? 0.0 : .pi
            let swing: Double, lift: Double, travel: Double
            if walking {
                swing = pow(max(0, sin(gait + p)), 2); lift = swing * 4; travel = swing * cos(gait + p) * 2.5
            } else if music.strength > 0, !speaking {
                swing = pow(max(0, sin(dancePhase + p)), 2)
                lift = swing * (1.4 + Double(index % 3) * 0.5) * music.strength
                travel = swing * cos(dancePhase + p) * (0.5 + Double(index % 2) * 0.5) * music.strength
            } else {
                swing = 0; lift = 0; travel = 0
            }
            solveLeg(rig: rig, side: side, targetOffset: CGPoint(x: travel, y: -lift), footAngle: swing * 2, pose: &pose)
        }
        return pose
    }

    /// Two-bone IK preserves authored lengths and the knee's bend direction; the ankle follows the support/swing target.
    static func solveLeg(rig: SkeletalRig, side: String, targetOffset: CGPoint, footAngle: Double,
                         pose: inout [String: BoneOffset]) {
        let thighID = "thigh-\(side)", shinID = "shin-\(side)", footID = "foot-\(side)"
        guard let thigh = rig.bones[thighID], let shin = rig.bones[shinID], let foot = rig.bones[footID] else { return }
        let matrices = rig.transforms(pose), parent = thigh.parent.flatMap { matrices[$0] } ?? BoneTransform()
        let hip = parent.point(thigh.point), ankle = CGPoint(x: foot.point.x + targetOffset.x, y: foot.point.y + targetOffset.y)
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
        pose[thighID] = BoneOffset(angle: wrapped(upper - bindUpper - parent.angle))
        pose[shinID] = BoneOffset(angle: wrapped(lower - bindLower - upper + bindUpper))
        // Counter-rotation keeps a planted shoe flat, including inherited pelvis rotation.
        let current = rig.transforms(pose)
        pose[footID] = BoneOffset(angle: wrapped(footAngle - (current[shinID]?.angle ?? 0)))
    }

    private static func wrapped(_ angle: Double) -> Double {
        var value = angle.truncatingRemainder(dividingBy: 360)
        if value > 180 { value -= 360 }; if value < -180 { value += 360 }
        return value
    }
}
