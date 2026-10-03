import Foundation

/// Drawn views and key poses complement joint animation; nothing creates a render timer.
enum PoseChoreography {
    static let working: Set<CharacterPose> = [.workThreeQuarter, .workProfile, .workBackThreeQuarter, .workSeated,
        .workRightThreeQuarter, .workRightProfile, .workBack, .workKneeling, .workLeaning, .workDesk]
    static let dancing: Set<CharacterPose> = [.dance1, .dance2, .dance3, .dance4]
    private static let defaultWork: [CharacterPose] = [.workThreeQuarter, .workProfile, .workRightThreeQuarter,
        .workSeated, .workBackThreeQuarter, .workRightProfile]
    private static let workPatterns: [String: [CharacterPose]] = [
        "edit": [.workDesk, .workThreeQuarter, .workSeated, .workLeaning, .workRightProfile],
        "test": [.workKneeling, .workThreeQuarter, .workRightProfile, .workLeaning, .workSeated],
        "build": [.workBackThreeQuarter, .workRightThreeQuarter, .workKneeling, .workBack, .workProfile],
        "delegate": [.walkLeft, .workThreeQuarter, .walkRight, .workRightThreeQuarter]
    ]
    private static let dancePatterns: [String: [CharacterPose]] = [
        "lead": [.dance1, .dance2, .dance3, .dance2, .dance4, .dance3],
        "code": [.dance1, .dance3, .dance2, .dance4, .dance2, .dance3],
        "research": [.dance2, .dance3, .dance4, .dance3, .dance1, .dance4],
        "review": [.dance1, .dance2, .dance1, .dance3, .dance4, .dance3],
        "designer": [.dance2, .dance4, .dance3, .dance2, .dance1, .dance4],
        "devops": [.dance1, .dance4, .dance2, .dance4, .dance3, .dance2],
        "tester": [.dance3, .dance2, .dance4, .dance1, .dance3, .dance4]
    ]
    private static let views: [CharacterPose] = [.standing, .workThreeQuarter, .workProfile, .workBackThreeQuarter,
        .workBack, .workRightProfile, .workRightThreeQuarter]

    static func work(activity: String?, cycle: UInt64, available: Set<CharacterPose>) -> CharacterPose {
        let poses = workPatterns[activity == "run" ? "test" : activity ?? ""] ?? defaultWork
        let valid = poses.filter { available.contains($0) }
        return valid.isEmpty ? .standing : valid[Int(cycle % UInt64(valid.count))]
    }

    /// Key poses advance every two measured beats; each heroine has a distinct phrase.
    static func dance(beat: MusicBeatState?, at time: Double, role: String, available: Set<CharacterPose>,
                      beatsPerPose: Int = ChoreographyClips.standard.dance.beatsPerPose) -> CharacterPose? {
        guard let beat, time.isFinite, beat.period.isFinite, beat.period > 0,
              beatsPerPose > 0, beat.strength(at: time) > 0.15 else { return nil }
        let position = max(0, (time - beat.anchor) / beat.period)
        guard position < Double(Int.max / 4), beat.sequence >= 0, beat.sequence < Int.max / 2 else { return nil }
        let phrase = (dancePatterns[role] ?? dancePatterns["lead"]!).filter { available.contains($0) }
        guard phrase.count >= 2 else { return nil }
        return phrase[((beat.sequence + Int(floor(position))) / beatsPerPose) % phrase.count]
    }

    /// Walk through authored silhouettes rather than mirroring a face or rotating a flat card.
    static func turn(from: CharacterPose, to: CharacterPose, available: Set<CharacterPose>) -> CharacterPose {
        guard let start = views.firstIndex(of: from), let end = views.firstIndex(of: to), abs(end - start) > 1 else { return to }
        let clockwise = (end - start + views.count) % views.count
        let step = clockwise <= views.count / 2 ? 1 : -1
        let next = views[(start + step + views.count) % views.count]
        return next == .standing || available.contains(next) ? next : to
    }
}
