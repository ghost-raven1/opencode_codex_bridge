import AppKit

@main struct SkeletalAnimationTests {
    static func check(_ valid: Bool, _ message: String, line: UInt = #line) {
        if !valid { FileHandle.standardError.write(Data("FAIL skeletal-animation:\(line): \(message)\n".utf8)); exit(1) }
    }
    static func separation(_ a: CGPoint, _ b: CGPoint) -> Double { hypot(a.x - b.x, a.y - b.y) }
    static func walkFrame(start: Double, clips: ChoreographyClips = .standard) -> PoseFrame {
        var animation = PoseAnimation(seed: "same-task", clips: clips), frame = PoseFrame()
        var entered: Double?
        for tick in 0...40 {
            let time = start + Double(tick) / 20
            frame = animation.advance(identity: "code", state: "working", speaking: false, dancing: false,
                available: Set(CharacterPose.allCases), at: time, reduced: false, activity: "delegate", invocation: "one")
            if animation.requested.isWalk, entered == nil { entered = time }
        }
        check(frame.kind.isWalk && frame.walkPhase != nil, "Walk has no local clock")
        let expected = (start + 2 - entered!) * .pi / (2 * clips.walk.stepSeconds)
        check(abs(frame.walkPhase! - expected) < 1e-8, "Walk ignored authored contact/passing timing")
        let before = animation.frame(at: start + 2, reduced: false)
        for _ in 0..<30 { _ = animation.frame(at: start + 2, reduced: false) }
        check(before.walkPhase == animation.frame(at: start + 2, reduced: false).walkPhase, "Redraw advanced the walk")
        _ = animation.advance(identity: "code", state: "working", speaking: false, dancing: false,
            available: Set(CharacterPose.allCases), at: start + 2.1, reduced: false, activity: "delegate", invocation: "two")
        check(animation.frame(at: start + 2.1, reduced: false).walkPhase == nil, "New invocation inherited the old stride")
        return frame
    }
    static func main() {
        _ = NSApplication.shared
        let directory = URL(fileURLWithPath: CommandLine.arguments[1])
        let base = LayeredRig.load(directory: directory), library = PoseRigLibrary(directory: directory)
        let standard = ChoreographyClips.standard
        let slow = ChoreographyClips(work: standard.work, dance: standard.dance,
            walk: .init(stepSeconds: 0.9, durationSeconds: 3.6, transitionSeconds: 0.22,
                        poses: standard.walk.poses, phases: standard.walk.phases, facing: standard.walk.facing))
        let first = walkFrame(start: 0), later = walkFrame(start: 1000), slowed = walkFrame(start: 0, clips: slow)
        check(abs(first.walkPhase! - later.walkPhase!) < 1e-8, "Wall clock changed the first step")
        check(abs(first.walkPhase! - slowed.walkPhase!) > 0.1, "Authored step duration had no effect")
        let skeletons = SkeletonManifest.read(directory: directory)
        var supportError = 0.0, limbError = 0.0, actionSignatures = Set<String>(), danceSignatures = Set<String>()
        for key in skeletons.keys.sorted() {
            let rig = (key.contains("/") ? library.rig(key) : base[key])!.skeleton!
            let role = String(key.split(separator: "/")[0]), posture = key.split(separator: "/").dropFirst().first.map(String.init) ?? "standing"
            for kind in ActionMotion.kinds { for frame in 0..<12 {
                let time = Double(frame) / 2
                let work = ActionMotion.pose(rig: role, kind: kind, time: time, seed: 31)
                check(!work.bones.isEmpty, "Missing joint clip: \(role)/\(kind)")
                let offsets = SkeletalMotion.offsets(rig: rig, role: role, posture: posture, time: time, seed: 7,
                    head: LayerPose(), work: work, music: MusicPose(), beat: nil, speaking: false, reduced: false)
                let matrices = rig.transforms(offsets)
                for side in ["left", "right"] {
                    // Every segment preserves authored length, including nonzero hand translations.
                    for chain in [["upper-arm-\(side)", "forearm-\(side)", "hand-\(side)"],
                                  ["thigh-\(side)", "shin-\(side)", "foot-\(side)"]] {
                        for pair in 0..<2 {
                            let a = rig.bones[chain[pair]]!.point, b = rig.bones[chain[pair + 1]]!.point
                            let delta = abs(separation(matrices[chain[pair]]!.point(a), matrices[chain[pair + 1]]!.point(b)) - separation(a, b))
                            limbError = max(limbError, delta)
                            check(delta < 1e-6, "Limb stretched: \(key)/\(kind)/\(chain[pair])")
                        }
                    }
                    let ankle = rig.bones["foot-\(side)"]!.point
                    let error = separation(matrices["foot-\(side)"]!.point(ankle), ankle)
                    supportError = max(supportError, error)
                    check(error < 0.1, "Working stance lost support: \(key)/\(kind)/\(side) \(error)")
                }
            } }
        }
        for role in CompanionRig.names {
            for kind in ActionMotion.kinds {
                let values = (0..<12).flatMap { frame -> [Double] in
                    let pose = ActionMotion.pose(rig: role, kind: kind, time: Double(frame) / 2, seed: 31)
                    return ["pelvis", "spine", "chest", "upper-arm-left", "upper-arm-right", "forearm-left", "forearm-right"].flatMap {
                        let bone = pose.bones[$0] ?? BoneOffset(); return [bone.angle, bone.x, bone.y]
                    }
                }
                actionSignatures.insert(values.map { String(format: "%.4f", $0) }.joined(separator: ","))
            }
            let rig = base[role]!.skeleton!
            var signature = [Double]()
            for frame in 0..<48 {
                let time = Double(frame) / 24, sequence = Int(floor(time / 0.5))
                let beat = MusicBeatState(anchor: Double(sequence) * 0.5, period: 0.5, sequence: sequence,
                    confidence: 1, audibleAt: time, allowance: 1, measuredAt: time)
                let music = MusicMotion.pose(beat: beat, time: time, column: 0, rig: role, reduced: false)
                let offsets = SkeletalMotion.offsets(rig: rig, role: role, posture: "standing", time: time, seed: 7,
                    head: LayerPose(), work: WorkPose(), music: music, beat: beat, speaking: false, reduced: false)
                let matrices = rig.transforms(offsets)
                var supported = 0
                for side in ["left", "right"] {
                    let foot = rig.bones["foot-\(side)"]!.point, moved = matrices["foot-\(side)"]!.point(foot)
                    if separation(moved, foot) < 0.1 { supported += 1 }
                    signature += [moved.x - foot.x, moved.y - foot.y]
                }
                check(supported >= 1, "Dance lifted both support feet: \(role)")
                let silent = SkeletalMotion.offsets(rig: rig, role: role, posture: "standing", time: time, seed: 7,
                    head: LayerPose(), work: WorkPose(), music: music, beat: beat, speaking: true, reduced: false)
                for side in ["left", "right"] {
                    let foot = rig.bones["foot-\(side)"]!.point
                    check(separation(rig.transforms(silent)["foot-\(side)"]!.point(foot), foot) < 0.1, "Speech retained a dance step")
                }
            }
            danceSignatures.insert(signature.map { String(format: "%.4f", $0) }.joined(separator: ","))
            for variant in 0..<4 {
                let idle = IdleMotion.pose(rig: role, state: "idle", time: 1.2, gestureElapsed: 1.2, variant: variant, seed: 7, reduced: false)
                check(!idle.bones.isEmpty, "Missing skeletal idle gesture: \(role)/\(variant)")
            }
            for state in StateMotion.kinds {
                check(!StateMotion.frame(rig: role, state: state, elapsed: 1, seed: 7, reduced: false).pose.bones.isEmpty,
                      "Missing skeletal reaction: \(role)/\(state)")
            }
            let breath = SkeletalMotion.offsets(rig: rig, role: role, posture: "standing", time: 1, seed: 7,
                head: LayerPose(bodyScaleY: 1.004), work: WorkPose(), music: MusicPose(), beat: nil,
                speaking: false, reduced: false, transitionAngle: 2)
            check((breath["chest"]?.y ?? 0) < 0, "Breathing never reached the chest")
            for side in ["left", "right"] {
                let foot = rig.bones["foot-\(side)"]!.point
                check(separation(rig.transforms(breath)["foot-\(side)"]!.point(foot), foot) < 0.1, "Skeletal turn moved support feet")
            }
            let reduced = SkeletalMotion.offsets(rig: rig, role: role, posture: "walk-left", time: 1, seed: 7,
                head: LayerPose(bodyScaleY: 1.004), work: ActionMotion.pose(rig: role, kind: "edit", time: 1, seed: 7),
                music: MusicPose(strength: 1), beat: nil, speaking: false, reduced: true, walkPhase: 1, transitionAngle: 2)
            check(reduced.isEmpty, "Reduce Motion animated a joint")
        }
        check(actionSignatures.count == 49, "Role/tool joint clips repeat: \(actionSignatures.count)/49")
        check(danceSignatures.count == 7, "Two roles share the same step pattern")
        print("PASS 105 rigs × 7 tools × 12 frames, 49 joint clips, seven measured step styles, floor poses, fixed arm/leg lengths, local authored walk clock, skeletal breathing/turns, idle/state clips and Reduce Motion; support \(supportError) px, limb \(limbError) px")
    }
}
