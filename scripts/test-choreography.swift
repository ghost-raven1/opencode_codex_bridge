import Foundation

@main struct ChoreographyTests {
    static let available = Set(CharacterPose.allCases.filter { $0 != .standing })
    static func sample(_ animation: inout PoseAnimation, _ time: Double, activity: String? = "read",
                       speaking: Bool = false, beat: MusicBeatState? = nil, reduced: Bool = false,
                       identity: String = "code", state: String = "working") -> PoseFrame {
        animation.advance(identity: identity, state: state, speaking: speaking,
            dancing: MusicMotion.pose(beat: beat, time: time, column: 1, rig: identity, reduced: reduced).strength > 0,
            available: available, at: time, reduced: reduced, activity: activity, beat: beat, role: identity)
    }
    static func beat(_ time: Double, period: Double = 0.5) -> MusicBeatState {
        let sequence = Int(floor(time / period))
        return MusicBeatState(anchor: Double(sequence) * period, period: period, sequence: sequence,
                              confidence: 1, audibleAt: time, allowance: 1, measuredAt: time)
    }
    static func main() {
        clipTiming()
        // Authored views remain opaque through all intermediate turns and a retargeted speech return.
        var work = PoseAnimation(seed: "work"), used = Set<CharacterPose>()
        for frame in 0..<2_880 {
            let time = Double(frame) / 24
            let pose = sample(&work, time)
            precondition(pose.opacity == 1, "A working turn made the character disappear")
            precondition(pose.scaleX >= 0.88 && pose.scaleY >= 0.985 && abs(pose.angle) <= 1)
            precondition(pose.kind != .reclining, "Working agent lay down")
            used.insert(pose.kind)
        }
        precondition(used.contains(.workThreeQuarter) && used.contains(.workProfile) &&
                     used.contains(.workRightThreeQuarter) && used.contains(.workSeated) &&
                     used.contains(.workBackThreeQuarter), "Drawn working views were unused: \(used)")
        let talking = sample(&work, 121, speaking: true)
        precondition(talking.opacity == 1)
        precondition(sample(&work, 122, speaking: true).kind == .standing,
                     "A profile with a neutral face was retained during narration")
        for index in 0..<120 {
            let pose = sample(&work, 122 + Double(index) / 24, activity: index % 2 == 0 ? "test" : "edit")
            precondition(pose.opacity == 1, "Repeated tools interrupted a turn with a blank frame")
        }
        precondition(sample(&work, 130, identity: "research").kind == .standing,
                     "A different identity inherited a working view")
        precondition(sample(&work, 131, state: "waiting").kind == .standing)
        var interrupted = PoseAnimation(seed: "retarget")
        _ = sample(&interrupted, 0); _ = sample(&interrupted, 1.2)
        let moving = sample(&interrupted, 1.35)
        let resumed = sample(&interrupted, 1.35, speaking: true)
        precondition(abs(moving.y - resumed.y) < 0.000001 && abs(moving.scaleX - resumed.scaleX) < 0.000001 &&
                     abs(moving.scaleY - resumed.scaleY) < 0.000001 && abs(moving.angle - resumed.angle) < 0.000001,
                     "Returning to speech snapped an intermediate authored turn")

        // Real tool actions choose meaningful drawn poses without depending on the role label alone.
        precondition(PoseChoreography.work(activity: "edit", cycle: 0, available: available) == .workDesk)
        precondition(PoseChoreography.work(activity: "test", cycle: 0, available: available) == .workKneeling)
        precondition(PoseChoreography.work(activity: "build", cycle: 0, available: available) == .workBackThreeQuarter)
        precondition(PoseChoreography.work(activity: "read", cycle: 0, available: [.workProfile]) == .workProfile)
        precondition(PoseChoreography.work(activity: "edit", cycle: 0, available: []) == .standing)
        precondition(PoseChoreography.turn(from: .standing, to: .workBackThreeQuarter, available: available) == .workThreeQuarter)
        precondition(PoseChoreography.turn(from: .workThreeQuarter, to: .workBackThreeQuarter, available: available) == .workProfile)

        var walk = PoseAnimation(seed: "walk"), steps = Set<CharacterPose>()
        for frame in 0..<120 {
            let pose = sample(&walk, Double(frame) / 24, activity: "delegate")
            if pose.kind.isWalk { steps.insert(pose.kind) }
            precondition(pose.opacity == 1)
        }
        precondition(steps == [.walkLeft, .walkRight], "Walking failed to alternate the authored steps")
        precondition(sample(&walk, 5, activity: "delegate").kind == .workThreeQuarter, "Walking did not finish")

        // Each dance has four distinct authored key poses locked to a real beat clock.
        var phrases = Set<String>()
        for role in ["lead", "code", "research", "review", "designer", "devops", "tester"] {
            let phrase = (0..<12).map { index -> CharacterPose in
                let time = Double(index) + 0.05
                return PoseChoreography.dance(beat: beat(time), at: time, role: role, available: available)!
            }
            precondition(Set(phrase) == PoseChoreography.dancing, "\(role) lost a dance key pose")
            phrases.insert(phrase.map(\.rawValue).joined(separator: ","))
            var dance = PoseAnimation(seed: role), drawn = Set<CharacterPose>()
            for frame in 0..<360 {
                let time = Double(frame) / 24
                let pose = sample(&dance, time, beat: beat(time), identity: role)
                precondition(pose.opacity == 1, "Dance key pose transition blanked \(role)")
                if pose.kind.isDance { drawn.insert(pose.kind) }
            }
            precondition(drawn == PoseChoreography.dancing)
            _ = sample(&dance, 15, speaking: true, beat: beat(15), identity: role)
            precondition(sample(&dance, 16, speaking: true, beat: beat(16), identity: role).kind == .standing)
            _ = sample(&dance, 17, identity: role)
            precondition(!sample(&dance, 18, identity: role).kind.isDance, "Stale music left a dancing rig")
        }
        precondition(phrases.count == 7, "Two heroines share the same dance phrase")
        let first = PoseChoreography.dance(beat: beat(0.05), at: 0.05, role: "code", available: available)
        precondition(first == PoseChoreography.dance(beat: beat(0.9), at: 0.9, role: "code", available: available),
                     "Key poses advanced faster than the two-beat hold")
        precondition(first != PoseChoreography.dance(beat: beat(1.05), at: 1.05, role: "code", available: available))
        precondition(PoseChoreography.dance(beat: beat(0), at: 10, role: "code", available: available) == nil)
        precondition(PoseChoreography.dance(beat: nil, at: 0, role: "code", available: available) == nil)
        precondition(PoseChoreography.dance(beat: beat(0), at: 0, role: "code", available: [.dance1]) == nil)
        // The live music clock fades gradually; a weak remaining beat must not restore a 30–50s legacy wait.
        var fading = PoseAnimation(seed: "music-return")
        for index in 0...96 {
            let time = Double(index) / 24
            _ = sample(&fading, time, beat: beat(time))
        }
        let lastBeat = beat(4)
        var firstWork: Double?
        for index in 97...168 {
            let time = Double(index) / 24, pose = sample(&fading, time, beat: lastBeat)
            precondition(pose.opacity == 1)
            if firstWork == nil && PoseChoreography.working.contains(pose.kind) { firstWork = time }
        }
        precondition((firstWork ?? .infinity) <= 6.8, "Fading music left the working agent standing for too long")
        var reduced = PoseAnimation(seed: "reduce")
        for index in 0..<40 {
            let time = Double(index) / 10
            let pose = sample(&reduced, time, beat: beat(time), reduced: true)
            precondition(!pose.kind.isDance && pose.angle == 0 && pose.y == 0 && pose.scaleX == 1)
        }
        print("PASS drawn work views, tool selection, intermediate turns, continuous visibility, walking, seven beat-synced dance phrases, speech/stale/reduced controls")
    }

    /// Durations and beat counts must come from the manifest rather than duplicate Swift constants.
    static func clipTiming() {
        let json = """
        {"work":{"selection":"activity","holdSeconds":[0.6,0.6],"turnSeconds":0.1,"settleSeconds":0.2},
         "dance":{"selection":"measured-beat","beatsPerPose":1,"transitionSeconds":0.1,
                   "poses":["dance-1","dance-2","dance-3","dance-4"]},
         "walk":{"stepSeconds":0.2,"durationSeconds":0.6,"transitionSeconds":0.1,
                  "poses":["walk-left","walk-right"],"phases":["contact","passing"],"facing":"right"}}
        """
        let clips = try! JSONDecoder().decode(ChoreographyClips.self, from: Data(json.utf8))
        precondition(clips.isValid)
        var work = PoseAnimation(seed: "custom", clips: clips)
        _ = sample(&work, 0); _ = sample(&work, 0.4)
        precondition(sample(&work, 0.7).kind == .workThreeQuarter)
        _ = sample(&work, 1.0)
        precondition(sample(&work, 1.21).kind == .workProfile, "Manifest work hold was ignored")
        var turn = PoseAnimation(seed: "custom-turn", clips: clips)
        for time in [0.0, 0.4, 0.51, 0.62] { _ = sample(&turn, time, activity: "build") }
        precondition(sample(&turn, 0.9, activity: "build").kind == .workBackThreeQuarter, "Manifest turn duration was ignored")
        var dance = PoseAnimation(seed: "custom-dance", clips: clips)
        _ = sample(&dance, 0.05, beat: beat(0.05))
        precondition(sample(&dance, 0.11, beat: beat(0.11)).kind == .dance1, "Manifest dance transition was ignored")
        _ = sample(&dance, 0.62, beat: beat(0.62))
        precondition(sample(&dance, 0.73, beat: beat(0.73)).kind == .dance3, "Manifest beatsPerPose was ignored")
        var walk = PoseAnimation(seed: "custom-walk", clips: clips)
        for time in [0.0, 0.4, 0.61] { _ = sample(&walk, time, activity: "delegate") }
        precondition(sample(&walk, 0.72, activity: "delegate").kind == .walkRight, "Manifest walk step was ignored")
        _ = sample(&walk, 1.05, activity: "delegate")
        precondition(sample(&walk, 1.3, activity: "delegate").kind == .workThreeQuarter, "Manifest walking duration was ignored")
        precondition(PoseChoreography.dance(beat: beat(0), at: 0, role: "code", available: available, beatsPerPose: 0) == nil)
        print("PASS authored hold, intermediate-turn, settle, beat, walk-step and walk-duration settings")
    }
}
