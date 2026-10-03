import AppKit

@main struct ActionMotionTests {
    static func main() {
        let rigs = ["lead", "code", "research", "review", "designer", "devops", "tester"]
        for rig in rigs {
            var signatures = Set<String>()
            for kind in ActionMotion.kinds {
                var frames = Set<String>()
                for frame in 0..<180 {
                    let pose = ActionMotion.pose(rig: rig, kind: kind, time: Double(frame) / 30, seed: 4)
                    for joint in pose.joints.values {
                        precondition(joint.angle.isFinite && abs(joint.angle) <= 2.6 && abs(joint.x) <= 1.5 && abs(joint.y) <= 1.5)
                    }
                    let signature = pose.joints.sorted(by: { $0.key < $1.key }).map { "\($0.key):\($0.value.angle):\($0.value.y)" }.joined()
                        + ":\(pose.headX):\(pose.headY):\(pose.bodyAngle)"
                    frames.insert(signature)
                    if frame == 37 { signatures.insert(signature) }
                }
                precondition(frames.count >= 120, "Frozen \(rig)/\(kind)")
            }
            precondition(signatures.count == 7, "Different tools have identical motions for \(rig)")
        }
        var animation = WorkAnimation(seed: "code")
        animation.update(active: true, at: 0, activity: "edit", invocation: "one")
        precondition(animation.pose(rig: "code", at: 0.8, reduced: false).clip == "code-edit")
        animation.update(active: true, at: 0.8, invocation: "one")
        precondition(animation.pose(rig: "code", at: 1.1, reduced: false).clip == "code-edit", "Short tool vanished before one readable beat")
        animation.update(active: true, at: 1.1, activity: "test", invocation: "one")
        precondition(animation.pose(rig: "code", at: 1.8, reduced: false).clip == "code-test")
        animation.update(active: true, at: 2, invocation: "two")
        precondition(animation.pose(rig: "code", at: 2.1, reduced: false).clip != "code-test", "Old invocation gesture survived new task")
        precondition(animation.pose(rig: "code", at: 3, reduced: true).joints.isEmpty)
        print("PASS 49 tool gestures, safe joint amplitudes, readable short actions, new invocation and reduced motion")
    }
}
