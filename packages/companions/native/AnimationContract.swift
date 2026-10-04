import Foundation

/// Stable rig IDs also bound the snapshots retained during interrupted gestures.
enum CompanionRig: String, CaseIterable {
    case lead, code, research, review, designer, devops, tester
    static let names = allCases.map(\.rawValue)
}

/// Local joint rotation/translation in atlas degrees and source pixels.
struct BoneOffset {
    var angle = 0.0, x = 0.0, y = 0.0
    func scaled(_ weight: Double) -> BoneOffset { BoneOffset(angle: angle * weight, x: x * weight, y: y * weight) }
    func adding(_ other: BoneOffset) -> BoneOffset {
        BoneOffset(angle: angle + other.angle, x: x + other.x, y: y + other.y)
    }
}

/// Source geometry is shared by rig validation, registration and cached face composition.
enum SpriteGeometry {
    static let width = 256
    static let height = 384
    static let feetBaseline = 368
    static let faceRows = 18
    static let size = CGSize(width: width, height: height)

    static func isAssetPath(_ file: String) -> Bool {
        let parts = file.split(separator: "/", omittingEmptySubsequences: false)
        return !parts.isEmpty && !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) && !file.contains("\\")
    }
}

/// Older manifests retain these schedules; authored clips override the corresponding durations.
enum AnimationTiming {
    static let reducedTransition = 0.15
    static let workEntryDelay = 1.2
    static let restDelay = 3.0
    static let activityDelay = 0.4
    static let activityHold = 3.0
    static let legacyTransition = 0.8
}

/// Version-one clip contract. Invalid metadata falls back to the older pose library, never to bad timings.
struct ChoreographyClips: Decodable, Equatable {
    struct Work: Decodable, Equatable {
        let selection: String
        let holdSeconds: [Double]
        let turnSeconds: Double
        let settleSeconds: Double
        var hold: ClosedRange<Double> { holdSeconds[0]...holdSeconds[1] }
    }
    struct Dance: Decodable, Equatable {
        let selection: String
        let beatsPerPose: Int
        let transitionSeconds: Double
        let poses: [String]
    }
    struct Walk: Decodable, Equatable {
        let stepSeconds: Double
        let durationSeconds: Double
        let transitionSeconds: Double?
        let poses: [String]
        let phases: [String]
        let facing: String
    }
    let work: Work
    let dance: Dance
    let walk: Walk
    var walkTransition: Double { walk.transitionSeconds ?? dance.transitionSeconds }
    var isValid: Bool {
        work.selection == "activity" && work.holdSeconds.count == 2 &&
        work.holdSeconds.allSatisfy(Self.positive) && work.holdSeconds[0] <= work.holdSeconds[1] &&
        Self.positive(work.turnSeconds) && Self.positive(work.settleSeconds) &&
        dance.selection == "measured-beat" && dance.beatsPerPose > 0 && Self.positive(dance.transitionSeconds) &&
        dance.poses.count == 4 && Set(dance.poses) == Set(["dance-1", "dance-2", "dance-3", "dance-4"]) &&
        Self.positive(walk.stepSeconds) && Self.positive(walk.durationSeconds) &&
        walk.durationSeconds >= walk.stepSeconds && walk.durationSeconds / walk.stepSeconds < Double(Int.max / 2) &&
        Self.positive(walkTransition) &&
        walk.poses == ["walk-left", "walk-right"] && walk.phases == ["contact", "passing"] && walk.facing == "right"
    }
    private static func positive(_ value: Double) -> Bool { value.isFinite && value > 0 }

    static let standard = ChoreographyClips(
        work: Work(selection: "activity", holdSeconds: [8, 14], turnSeconds: 0.3, settleSeconds: 0.55),
        dance: Dance(selection: "measured-beat", beatsPerPose: 2, transitionSeconds: 0.22,
                     poses: ["dance-1", "dance-2", "dance-3", "dance-4"]),
        walk: Walk(stepSeconds: 0.65, durationSeconds: 2.6, transitionSeconds: 0.22,
                   poses: ["walk-left", "walk-right"], phases: ["contact", "passing"], facing: "right"))
}
