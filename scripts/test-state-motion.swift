import AppKit

@main struct StateMotionTests {
    static func main() {
        let roles = ["lead", "code", "research", "review", "designer", "devops", "tester"]
        for rig in roles {
            var states = Set<String>()
            for state in StateMotion.kinds {
                var frames = Set<String>()
                for n in 0..<120 {
                    let time = Double(n) / 60
                    let frame = StateMotion.frame(rig: rig, state: state, elapsed: time, seed: 4, reduced: false)
                    precondition(frame.weight.isFinite && (0...1).contains(frame.weight))
                    let pose = frame.pose
                    precondition(abs(pose.headAngle) <= 2 && abs(pose.headY) <= 1.3 && abs(pose.bodyAngle) <= 1)
                    precondition(pose.joints.values.allSatisfy { $0.angle.isFinite && abs($0.angle) <= 2.5 && abs($0.y) <= 1.3 })
                    let signature = "\(pose.headAngle):\(pose.headY):\(pose.joints):\(frame.weight)"
                    frames.insert(signature)
                    if n == 40 { states.insert(signature) }
                }
                precondition(frames.count > 100, "Frozen state reaction: \(rig)/\(state)")
                precondition(StateMotion.frame(rig: rig, state: state, elapsed: 1, seed: 4, reduced: true).weight == 0)
            }
            precondition(states.count == 4, "Permission, focus and result gestures look identical: \(rig)")
            for terminal in ["success", "error"] {
                precondition(StateMotion.frame(rig: rig, state: terminal, elapsed: 10, seed: 4, reduced: false).weight == 0,
                             "Terminal reaction repeats forever")
            }
            for time in [1.0, 10.0, 20.0] {
                precondition(StateMotion.frame(rig: rig, state: "waiting", elapsed: time, seed: 4, reduced: false).weight > 0)
            }
        }
        var animation = StateAnimation(seed: "reviewer")
        animation.update(state: "success", at: 10, invocation: "one", speaking: true)
        precondition(animation.frame(rig: "review", at: 100, reduced: false).weight == 0,
                     "Success reaction elapsed before narration finished")
        animation.update(state: "success", at: 100, invocation: "one", speaking: false)
        let started = animation.frame(rig: "review", at: 101, reduced: false)
        precondition(started.weight > 0.5, "Finishing narration lost the result reaction")
        animation.update(state: "success", at: 101, invocation: "one", speaking: true)
        let paused = animation.frame(rig: "review", at: 110, reduced: false)
        precondition(abs(paused.weight - started.weight) < 0.000001, "Narration advanced a paused gesture")
        animation.update(state: "success", at: 110, invocation: "one", speaking: false)
        precondition(abs(animation.frame(rig: "review", at: 110, reduced: false).weight - paused.weight) < 0.000001)
        animation.update(state: "success", at: 120, invocation: "one", speaking: false)
        precondition(animation.frame(rig: "review", at: 120, reduced: false).weight == 0,
                     "Repeated terminal metadata replayed a consumed gesture")
        animation.update(state: "thinking", at: 121, invocation: "two", speaking: false)
        precondition(animation.frame(rig: "review", at: 121, reduced: false).weight == 0,
                     "New invocation inherited the previous reaction")
        precondition(animation.frame(rig: "review", at: 122, reduced: false).weight > 0.5)
        animation.update(state: "waiting", at: 123, invocation: "two", speaking: false)
        let waiting = animation.frame(rig: "review", at: 124, reduced: false)
        animation.update(state: "working", at: 124, invocation: "two", speaking: false)
        precondition(abs(animation.frame(rig: "review", at: 124, reduced: false).weight - waiting.weight) < 0.000001,
                     "Resuming work snapped a permission gesture")
        precondition(animation.frame(rig: "review", at: 124.36, reduced: false).weight == 0)
        print("PASS 28 layered state gestures, bounded joints, permission loop, narration pause/resume, invocation reset and Reduce Motion")
    }
}
