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
                positions.insert(pose.joints.sorted(by: { $0.key < $1.key }).map { "\($0.key):\($0.value.angle):\($0.value.x):\($0.value.y)" }.joined())
            }
            precondition(positions.count > 1000, "Work motion must continue between gestures: \(rig)")
            precondition(clips.count == 4, "Expected a continuous focus loop, two gestures and initial fade: \(rig)")
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
        print("PASS seven continuous work styles, fourteen accent gestures, independent joint motion, soft stop and reduced motion")
    }
}
