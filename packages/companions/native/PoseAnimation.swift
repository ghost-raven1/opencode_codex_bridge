import Foundation

enum CharacterPose: String, CaseIterable {
    case standing, seated, reclining
    case workThreeQuarter = "work-three-quarter", workProfile = "work-profile"
    case workBackThreeQuarter = "work-back-three-quarter", workSeated = "work-seated"
    case workRightThreeQuarter = "work-right-three-quarter", workRightProfile = "work-right-profile", workBack = "work-back"
    case walkLeft = "walk-left", walkRight = "walk-right", workKneeling = "work-kneeling"
    case workLeaning = "work-leaning", workDesk = "work-desk"
    case dance1 = "dance-1", dance2 = "dance-2", dance3 = "dance-3", dance4 = "dance-4"

    var isDrawn: Bool { self != .standing && self != .seated && self != .reclining }
    var isDance: Bool { PoseChoreography.dancing.contains(self) }
    var isWalk: Bool { self == .walkLeft || self == .walkRight }
}

struct PoseLayer { let kind: CharacterPose; let weight: Double }

struct PoseFrame {
    var kind: CharacterPose = .standing
    var opacity: Double = 1
    var scaleY: Double = 1
    var y: Double = 0
    var angle: Double = 0
    var scaleX: Double = 1
    /// Radians on the invocation's authored contact/passing clock; absent outside walking.
    var walkPhase: Double?
    /// All interrupted contributions are retained until they fade; authored poses bound this list.
    var layers: [PoseLayer] = []
}

/// Slow per-character posture changes share the existing render clock and never create timers.
struct PoseAnimation {
    private let seed: UInt64
    private let clips: ChoreographyClips
    private var identity = ""
    private var invocation: String?
    private var mode = ""
    private var nextChange = Double.infinity
    private var cycle: UInt64 = 0
    private var target: CharacterPose = .standing
    private var previous: CharacterPose = .standing
    private var changedAt = -Double.infinity
    private var initialOpacity = 1.0
    private var initialFrame = PoseFrame()
    private var pending: CharacterPose?
    private var activity: String?
    private var continuous = false
    private var duration = AnimationTiming.legacyTransition
    private var walkUntil = -Double.infinity
    private var walkStarted = 0.0
    private var firstStep: CharacterPose = .walkLeft

    init(seed: String, clips: ChoreographyClips = .standard) {
        self.seed = seed.utf8.reduce(UInt64(14695981039346656037)) { ($0 ^ UInt64($1)) &* 1099511628211 }
        self.clips = clips.isValid ? clips : .standard
    }

    var requested: CharacterPose { target }

    mutating func advance(identity: String, state: String, speaking: Bool, dancing: Bool,
                          available: Set<CharacterPose>, at time: Double, reduced: Bool,
                          activity: String? = nil, beat: MusicBeatState? = nil, role: String = "lead",
                          invocation: String? = nil) -> PoseFrame {
        guard time.isFinite else { return PoseFrame() }
        let nextMode = ["thinking", "working"].contains(state) ? "work" : ["success", "idle"].contains(state) ? "rest" : "blocked"
        if self.identity != identity || self.invocation != invocation {
            self.identity = identity; self.invocation = invocation; mode = ""; cycle = 0
            target = .standing; previous = .standing; changedAt = -.infinity; initialOpacity = 1; initialFrame = PoseFrame()
            pending = nil; self.activity = nil; walkUntil = -.infinity
        }
        let rich = !available.isDisjoint(with: PoseChoreography.working)
        var desired = target
        if mode != nextMode {
            mode = nextMode
            nextChange = time + (mode == "rest" ? AnimationTiming.restDelay : rich ? AnimationTiming.workEntryDelay : interval())
            pending = nil
            if mode != "rest" || target == .reclining { desired = .standing }
        }
        if rich, self.activity != activity {
            self.activity = activity
            if mode == "work" { nextChange = min(nextChange, max(time + AnimationTiming.activityDelay, changedAt + AnimationTiming.activityHold)) }
        }
        let dance = !speaking && !reduced ? PoseChoreography.dance(beat: beat, at: time, role: role,
            available: available, beatsPerPose: clips.dance.beatsPerPose) : nil
        if let dance {
            desired = dance; pending = nil; nextChange = time + interval(rich: true)
        } else if dancing || mode == "blocked" {
            desired = .standing
            pending = nil
            nextChange = time + (rich ? AnimationTiming.workEntryDelay : interval())
        } else if speaking {
            if rich { desired = .standing; pending = nil }
            if desired == .reclining { desired = .standing }
            // Finish the current sentence before changing posture.
            nextChange = max(nextChange, time + (mode == "rest" ? AnimationTiming.restDelay : 1))
        } else if let endpoint = pending, time >= changedAt + duration {
            desired = PoseChoreography.turn(from: target, to: endpoint, available: available)
            if desired == endpoint { pending = nil }
        } else if target.isDance {
            desired = .standing; pending = nil; nextChange = time + AnimationTiming.workEntryDelay
        } else if target.isWalk {
            if time >= walkUntil { desired = available.contains(.workThreeQuarter) ? .workThreeQuarter : .standing }
            else if !reduced, available.contains(.walkLeft), available.contains(.walkRight) {
                desired = Int((time - walkStarted) / clips.walk.stepSeconds) % 2 == 0 ? firstStep : firstStep == .walkLeft ? .walkRight : .walkLeft
            }
        } else if time >= nextChange {
            if mode == "work" {
                desired = rich ? PoseChoreography.work(activity: activity, cycle: cycle, available: available)
                               : target == .seated ? .standing : .seated
                cycle &+= 1; nextChange = time + interval(rich: rich)
            } else if mode == "rest" { desired = .reclining }
        }
        if desired != .standing && !available.contains(desired) { desired = .standing }
        if rich, !speaking, !desired.isDance, pending == nil {
            let step = PoseChoreography.turn(from: target, to: desired, available: available)
            if step != desired { pending = desired; desired = step }
        }
        if desired != target {
            let displayed = frame(at: time, reduced: reduced)
            previous = displayed.kind; initialOpacity = displayed.opacity; initialFrame = displayed
            if desired.isWalk && !target.isWalk { walkStarted = time; walkUntil = time + clips.walk.durationSeconds; firstStep = desired }
            target = desired; changedAt = time
            continuous = rich
            duration = target.isDance || previous.isDance ? clips.dance.transitionSeconds
                : target.isWalk ? clips.walkTransition : pending != nil ? clips.work.turnSeconds
                : rich ? clips.work.settleSeconds : AnimationTiming.legacyTransition
        }
        return frame(at: time, reduced: reduced)
    }

    /// Keep authored turns visible; legacy poses retain their original single-silhouette fade.
    func frame(at time: Double, reduced: Bool) -> PoseFrame {
        var result = transitionFrame(at: time, reduced: reduced)
        if result.kind.isWalk || result.layers.contains(where: { $0.kind.isWalk }), !reduced, time.isFinite {
            // Contact and passing are half a step apart; the full two-foot stride lasts four keyframes.
            result.walkPhase = max(0, time - walkStarted) * .pi / (2 * clips.walk.stepSeconds)
                + (firstStep == .walkRight ? .pi / 2 : 0)
        }
        return result
    }

    private func transitionFrame(at time: Double, reduced: Bool) -> PoseFrame {
        let t = min(1, max(0, (time - changedAt) / (reduced ? AnimationTiming.reducedTransition : duration)))
        if t >= 1 { return PoseFrame(kind: target) }
        let initial = reduced ? PoseFrame() : initialFrame
        let smooth: (Double) -> Double = { $0 * $0 * (3 - 2 * $0) }
        if continuous {
            guard !reduced else { return PoseFrame(kind: t < 0.5 ? previous : target) }
            let blend = smooth(t < 0.5 ? t * 2 : (t - 0.5) * 2)
            let squeeze = target.isDance || previous.isDance || target.isWalk ? 0.035 : 0.12
            let x = t < 0.5 ? initial.scaleX + (1 - squeeze - initial.scaleX) * blend : 1 - squeeze * (1 - blend)
            let y = t < 0.5 ? initial.y + (-1.8 - initial.y) * blend : -1.8 * (1 - blend)
            let angle = t < 0.5 ? initial.angle * (1 - blend) + sin(t * 2 * .pi) * blend : sin(t * 2 * .pi)
            let amount = smooth(t)
            let from = initial.layers.isEmpty ? [PoseLayer(kind: previous, weight: 1)] : initial.layers
            var weights: [CharacterPose: Double] = [:]
            for layer in from { weights[layer.kind, default: 0] += layer.weight * (1 - amount) }
            weights[target, default: 0] += amount
            let layers = weights.keys.sorted { $0.rawValue < $1.rawValue }.map { PoseLayer(kind: $0, weight: weights[$0]!) }
            return PoseFrame(kind: t < 0.5 ? previous : target, opacity: 1,
                scaleY: 1, y: y, angle: angle, scaleX: x, layers: layers)
        }
        if previous == target {
            let blend = smooth(t)
            return PoseFrame(kind: target, opacity: initialOpacity + (1 - initialOpacity) * blend,
                scaleY: initial.scaleY + (1 - initial.scaleY) * blend,
                y: initial.y * (1 - blend), angle: initial.angle * (1 - blend))
        }
        let dip = reduced ? 0 : sin(t * .pi)
        if t < 0.5 {
            return PoseFrame(kind: previous, opacity: initialOpacity * (1 - smooth(t * 2)),
                             scaleY: 1 - dip * 0.025 + (initial.scaleY - 1) * (1 - smooth(t * 2)),
                             y: -dip * 3 + initial.y * (1 - smooth(t * 2)),
                             angle: dip * 0.6 + initial.angle * (1 - smooth(t * 2)))
        }
        return PoseFrame(kind: target, opacity: smooth((t - 0.5) * 2),
                         scaleY: 1 - dip * 0.025, y: -dip * 3, angle: -dip * 0.6)
    }

    private func interval(rich: Bool = false) -> Double {
        let value = (seed &+ cycle &* 0x9E3779B97F4A7C15) &* 0xBF58476D1CE4E5B9
        let hold = clips.work.hold
        return rich ? hold.lowerBound + (hold.upperBound - hold.lowerBound) * Double(value % 6_001) / 6_000
                    : 30 + Double(value % 20_001) / 1000
    }
}
