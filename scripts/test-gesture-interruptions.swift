import AppKit

@main struct GestureInterruptionTests {
    static func distance(_ a: WorkPose, _ b: WorkPose) -> Double {
        var values = [a.headX - b.headX, a.headY - b.headY, a.headAngle - b.headAngle, a.bodyAngle - b.bodyAngle]
        for key in Set(a.joints.keys).union(b.joints.keys) {
            let x = a.joints[key] ?? WorkJoint(), y = b.joints[key] ?? WorkJoint()
            values += [x.angle - y.angle, x.x - y.x, x.y - y.y]
        }
        for key in Set(a.bones.keys).union(b.bones.keys) {
            let x = a.bones[key] ?? BoneOffset(), y = b.bones[key] ?? BoneOffset()
            values += [CGFloat(x.angle - y.angle), CGFloat(x.x - y.x), CGFloat(x.y - y.y)]
        }
        return values.map { abs(Double($0)) }.max() ?? 0
    }
    static func main() {
        for rig in CompanionRig.names {
            var state = StateAnimation(seed: "interrupt")
            state.update(state: "thinking", at: 0, invocation: "one", speaking: false)
            for n in 0..<30 {
                let time = 1 + Double(n) * 0.05
                let before = state.frame(rig: rig, at: time, reduced: false)
                state.update(state: StateMotion.kinds[n % 4], at: time, invocation: "one", speaking: false)
                let after = state.frame(rig: rig, at: time, reduced: false)
                precondition(abs(before.weight - after.weight) < 1e-9)
                precondition(distance(before.pose.scaled(before.weight), after.pose.scaled(after.weight)) < 1e-9,
                             "Interrupted state snapped: \(rig)")
            }
            var work = WorkAnimation(seed: "interrupt")
            work.update(active: true, at: 0, activity: "edit", invocation: "one")
            for n in 0..<30 {
                let time = 1 + Double(n) * 0.05
                let before = work.pose(rig: rig, at: time, reduced: false)
                work.update(active: true, at: time, activity: ["search", "test", "edit"][n % 3], invocation: "one")
                precondition(distance(before, work.pose(rig: rig, at: time, reduced: false)) < 1e-9,
                             "Interrupted tool snapped: \(rig)")
            }
            let old = work.pose(rig: rig, at: 10, reduced: false)
            work.update(active: true, at: 10, activity: "edit", invocation: "one")
            precondition(distance(old, work.pose(rig: rig, at: 10, reduced: false)) < 1e-9,
                         "Renewing an expired tool snapped: \(rig)")
            let action = TeamAction(kind: .handoff, source: "parent", target: "child", start: 0)
            let base = WorkPose(headX: 1, headY: 1, bodyAngle: 0.2)
            let music = MusicPose(x: 3, angle: 5, arm: 1, strength: 1)
            let middle = TeamMotion.blend(work: base, music: music, action: action, id: "parent", rig: rig,
                direction: 1, at: 1.4, reduced: false, speaking: false)
            precondition(middle.music.strength == 0)
            precondition(distance(middle.work, TeamMotion.pose(action, id: "parent", rig: rig, direction: 1,
                at: 1.4, reduced: false)) < 1e-9, "Music erased a team handoff: \(rig)")
            for time in [0.0, action.end] {
                let edge = TeamMotion.blend(work: base, music: music, action: action, id: "parent", rig: rig,
                    direction: 1, at: time, reduced: false, speaking: false)
                precondition(abs(edge.music.strength - 1) < 1e-9 && distance(edge.work, WorkPose()) < 1e-9)
            }
        }
        print("PASS interrupted state/tool continuity across seven rigs, expired tool renewal and smooth team/music priority")
    }
}
