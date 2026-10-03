import Foundation

/// Drawn views and key poses complement joint animation; nothing creates a render timer.
enum PoseChoreography {
    static let working: Set<CharacterPose> = [.workThreeQuarter, .workProfile, .workBackThreeQuarter, .workSeated,
        .workRightThreeQuarter, .workRightProfile, .workBack, .workKneeling, .workLeaning, .workDesk]
    static let dancing: Set<CharacterPose> = [.dance1, .dance2, .dance3, .dance4]

    static func work(activity: String?, cycle: UInt64, available: Set<CharacterPose>) -> CharacterPose {
        let poses: [CharacterPose]
        switch activity {
        case "edit": poses = [.workDesk, .workThreeQuarter, .workSeated, .workLeaning, .workRightProfile]
        case "test", "run": poses = [.workKneeling, .workThreeQuarter, .workRightProfile, .workLeaning, .workSeated]
        case "build": poses = [.workBackThreeQuarter, .workRightThreeQuarter, .workKneeling, .workBack, .workProfile]
        case "delegate": poses = [.walkLeft, .workThreeQuarter, .walkRight, .workRightThreeQuarter]
        default: poses = [.workThreeQuarter, .workProfile, .workRightThreeQuarter, .workSeated, .workBackThreeQuarter, .workRightProfile]
        }
        let valid = poses.filter { available.contains($0) }
        return valid.isEmpty ? .standing : valid[Int(cycle % UInt64(valid.count))]
    }

    /// Key poses advance every two measured beats; each heroine has a distinct phrase.
    static func dance(beat: MusicBeatState?, at time: Double, role: String, available: Set<CharacterPose>) -> CharacterPose? {
        guard let beat, time.isFinite, beat.period.isFinite, beat.period > 0,
              beat.strength(at: time) > 0.15 else { return nil }
        let position = max(0, (time - beat.anchor) / beat.period)
        guard position < Double(Int.max / 4), beat.sequence >= 0, beat.sequence < Int.max / 2 else { return nil }
        let patterns: [String: [CharacterPose]] = [
            "lead": [.dance1, .dance2, .dance3, .dance2, .dance4, .dance3],
            "code": [.dance1, .dance3, .dance2, .dance4, .dance2, .dance3],
            "research": [.dance2, .dance3, .dance4, .dance3, .dance1, .dance4],
            "review": [.dance1, .dance2, .dance1, .dance3, .dance4, .dance3],
            "designer": [.dance2, .dance4, .dance3, .dance2, .dance1, .dance4],
            "devops": [.dance1, .dance4, .dance2, .dance4, .dance3, .dance2],
            "tester": [.dance3, .dance2, .dance4, .dance1, .dance3, .dance4]
        ]
        let phrase = (patterns[role] ?? patterns["lead"]!).filter { available.contains($0) }
        guard phrase.count >= 2 else { return nil }
        return phrase[((beat.sequence + Int(floor(position))) / 2) % phrase.count]
    }

    /// Walk through authored silhouettes rather than mirroring a face or rotating a flat card.
    static func turn(from: CharacterPose, to: CharacterPose, available: Set<CharacterPose>) -> CharacterPose {
        let views: [CharacterPose] = [.standing, .workThreeQuarter, .workProfile, .workBackThreeQuarter,
                                      .workBack, .workRightProfile, .workRightThreeQuarter]
        guard let start = views.firstIndex(of: from), let end = views.firstIndex(of: to), abs(end - start) > 1 else { return to }
        let clockwise = (end - start + views.count) % views.count
        let step = clockwise <= views.count / 2 ? 1 : -1
        let next = views[(start + step + views.count) % views.count]
        return next == .standing || available.contains(next) ? next : to
    }
}
