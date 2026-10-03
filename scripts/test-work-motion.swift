import AppKit

@main struct WorkMotionTests {
    static func main() {
        for rig in ["lead", "code", "research", "review", "designer", "devops", "tester"] {
            var animation = WorkAnimation(seed: "agent-\(rig)")
            animation.update(active: true, at: 0)
            var positions = Set<String>(), clips = Set<String>()
            for frame in 0..<1800 {
                let time = Double(frame) / 30
                let pose = animation.pose(rig: rig, at: time, reduced: false)
                clips.insert(pose.clip)
                if time >= 0.3 {
                    precondition(!pose.joints.isEmpty, "Active \(rig) stood still at \(time)s between work gestures")
                }
                for (_, joint) in pose.joints {
                    precondition(joint.angle.isFinite && abs(joint.angle) <= 3)
                    precondition(joint.x.isFinite && abs(joint.x) <= 1.5)
                    precondition(joint.y.isFinite && abs(joint.y) <= 1.5)
                }
                precondition(abs(pose.bodyAngle) <= 0.51 && abs(pose.headAngle) <= 0.61)
                positions.insert(pose.joints.sorted(by: { $0.key < $1.key }).map { "\($0.key):\($0.value.angle):\($0.value.x):\($0.value.y)" }.joined())
            }
            precondition(positions.count > 1000, "Work motion must continue between gestures: \(rig)")
            precondition(clips.count == 6, "Expected a continuous focus loop, four gestures and initial fade: \(rig)")
            precondition(animation.pose(rig: rig, at: 4, reduced: true).joints.isEmpty)
            let before = animation.pose(rig: rig, at: 20, reduced: false)
            animation.update(active: false, at: 20)
            let after = animation.pose(rig: rig, at: 20, reduced: false)
            precondition(before.headY == after.headY, "Leaving work must not snap the head")
            precondition(animation.pose(rig: rig, at: 20.4, reduced: false).joints.isEmpty)
        }
        var first = WorkAnimation(seed: "first"), second = WorkAnimation(seed: "second")
        first.update(active: true, at: 0); second.update(active: true, at: 0)
        let different = (1...300).contains { frame in
            first.pose(rig: "code", at: Double(frame) / 30, reduced: false).headY != second.pose(rig: "code", at: Double(frame) / 30, reduced: false).headY
        }
        precondition(different, "Different characters must not gesture in unison")
        for rig in ["lead", "code", "research", "review", "designer", "devops", "tester"] {
            var clips = Set<String>()
            for variant in 0..<4 {
                var frames = Set<String>()
                for frame in 0...144 {
                    let time = Double(frame) / 30
                    let rest = IdleMotion.pose(rig: rig, state: "idle", time: time, gestureElapsed: time, variant: variant, seed: 5, reduced: false)
                    if frame > 0 && frame < 144 { clips.insert(rest.clip) }
                    frames.insert("\(rest.headX):\(rest.headY):\(rest.headAngle):\(rest.bodyAngle)")
                    precondition(abs(rest.bodyAngle) <= 0.71 && abs(rest.headX) <= 1.21 && abs(rest.headY) <= 0.91)
                    precondition(rest.joints.values.allSatisfy { abs($0.angle) <= 1.8 && abs($0.y) <= 0.5 })
                }
                precondition(frames.count > 60)
                precondition(IdleMotion.pose(rig: rig, state: "idle", time: 2, gestureElapsed: 2, variant: variant, seed: 5, reduced: true).joints.isEmpty)
            }
            precondition(clips.count == 4, "Idle variants are unreachable")
            let idle = IdleMotion.pose(rig: rig, state: "idle", time: 3, gestureElapsed: 3, variant: 1, seed: 5, reduced: false)
            var blend = WorkAnimation(seed: rig); blend.update(active: true, at: 3)
            let start = blend.pose(rig: rig, at: 3, reduced: false, rest: idle)
            precondition(start.headX == idle.headX && start.bodyAngle == idle.bodyAngle, "Starting work snapped away from rest")
            precondition(blend.pose(rig: rig, at: 4, reduced: false, rest: idle).clip != idle.clip)
        }
        print("PASS twenty-eight independent idle gestures, bounded props, continuous rest/work blend and reduced motion")
        print("PASS seven continuous work styles, twenty-eight accent gestures, independent joint motion, soft stop and reduced motion")
    }
}
