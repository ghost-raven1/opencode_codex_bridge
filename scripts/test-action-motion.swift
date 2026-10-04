import AppKit

@main struct ActionMotionTests {
    static func distance(_ a: WorkPose, _ b: WorkPose) -> Double {
        var values = [Double(a.headX - b.headX), Double(a.headY - b.headY),
                      Double(a.headAngle - b.headAngle), Double(a.bodyAngle - b.bodyAngle)]
        for id in Set(a.joints.keys).union(b.joints.keys) {
            let x = a.joints[id] ?? WorkJoint(), y = b.joints[id] ?? WorkJoint()
            values += [Double(x.angle - y.angle), Double(x.x - y.x), Double(x.y - y.y)]
        }
        for id in Set(a.bones.keys).union(b.bones.keys) {
            let x = a.bones[id] ?? BoneOffset(), y = b.bones[id] ?? BoneOffset()
            values += [x.angle - y.angle, x.x - y.x, x.y - y.y]
        }
        return values.map(abs).max() ?? 0
    }

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
                    for bone in pose.bones.values {
                        precondition(bone.angle.isFinite && abs(bone.angle) <= 3.5)
                        precondition(bone.x.isFinite && abs(bone.x) <= 0.81 && bone.y == 0,
                                     "Tool action changes stature or stretches a bone: \(rig)/\(kind)")
                    }
                    let signature = pose.joints.sorted(by: { $0.key < $1.key }).map { "\($0.key):\($0.value.angle):\($0.value.y)" }.joined()
                        + ":\(pose.headX):\(pose.headY):\(pose.bodyAngle)"
                    frames.insert(signature)
                    if frame == 37 { signatures.insert(signature) }
                }
                precondition(frames.count >= 120, "Frozen \(rig)/\(kind)")
                for seed in [UInt64(0), 4, 987] {
                    let start = ActionMotion.pose(rig: rig, kind: kind, time: 0, seed: seed)
                    let finish = ActionMotion.pose(rig: rig, kind: kind, time: 1.2, seed: seed)
                    precondition(distance(start, WorkPose()) < 1e-9, "Action began in the middle of its gesture: \(rig)/\(kind)")
                    precondition(distance(finish, start) < 1e-9, "Short action did not finish its first gesture: \(rig)/\(kind)")
                    let peak = (1..<36).map { frame in
                        distance(start, ActionMotion.pose(rig: rig, kind: kind, time: Double(frame) / 30, seed: seed))
                    }.max() ?? 0
                    precondition(peak > 1, "Short action is too subtle to read: \(rig)/\(kind)")
                    for edge in [0.0, 1.2, 1.2 + 3.8 + Double(seed % 7) * 0.1] {
                        let a = ActionMotion.pose(rig: rig, kind: kind, time: max(0, edge - 0.001), seed: seed)
                        let b = ActionMotion.pose(rig: rig, kind: kind, time: edge + 0.001, seed: seed)
                        precondition(distance(a, b) < 0.02, "Action phase boundary snapped: \(rig)/\(kind)")
                    }
                }
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
        let keyLeft = ActionMotion.pose(rig: "code", kind: "edit", time: 0.7, seed: 4).bones
        let keyRight = ActionMotion.pose(rig: "code", kind: "edit", time: 0.45, seed: 4).bones
        precondition(abs(keyLeft["forearm-left"]!.angle) > abs(keyLeft["forearm-right"]!.angle), "Keyboard left hand never takes its turn")
        precondition(abs(keyRight["forearm-right"]!.angle) > abs(keyRight["forearm-left"]!.angle), "Keyboard right hand never takes its turn")
        let sketch = ActionMotion.pose(rig: "designer", kind: "edit", time: 0.45, seed: 4).bones
        precondition(abs(sketch["forearm-left"]!.angle) > abs(sketch["forearm-right"]!.angle), "Stylus gesture lost the left drawing hand")
        for rig in rigs {
            for kind in ActionMotion.kinds {
                var early = WorkAnimation(seed: "same-agent"), late = WorkAnimation(seed: "same-agent")
                early.update(active: true, at: 0, activity: kind, invocation: "one")
                late.update(active: true, at: 1000, activity: kind, invocation: "one")
                for elapsed in [0.45, 0.6, 0.9, 1.1] {
                    precondition(distance(early.pose(rig: rig, at: elapsed, reduced: false),
                                          late.pose(rig: rig, at: 1000 + elapsed, reduced: false)) < 1e-9,
                                 "Tool timing depends on system uptime: \(rig)/\(kind)")
                }
                let before = early.pose(rig: rig, at: 0.7, reduced: false)
                early.update(active: true, at: 0.7, activity: kind, invocation: "one")
                precondition(distance(before, early.pose(rig: rig, at: 0.7, reduced: false)) < 1e-9,
                             "Repeated metadata restarted an action: \(rig)/\(kind)")
                precondition(distance(early.pose(rig: rig, at: 1.1, reduced: false),
                                      late.pose(rig: rig, at: 1001.1, reduced: false)) < 1e-9)
                early.update(active: true, at: 7, activity: kind, invocation: "two")
                precondition(distance(early.pose(rig: rig, at: 7.8, reduced: false),
                                      late.pose(rig: rig, at: 1000.8, reduced: false)) < 1e-9,
                             "New invocation inherited the old action phase: \(rig)/\(kind)")
                precondition(early.pose(rig: rig, at: 7.8, reduced: true).bones.isEmpty)
            }
        }
        print("PASS 49 tool gestures, safe joint amplitudes, readable short actions, new invocation and reduced motion")
        print("PASS prepared short gestures, smooth action cycle boundaries, local action clocks and metadata continuity")
    }
}
