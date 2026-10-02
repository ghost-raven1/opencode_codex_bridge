import Foundation

enum CharacterPose: String, CaseIterable {
    case standing, seated, reclining
}

struct PoseFrame {
    var kind: CharacterPose = .standing
    var opacity: Double = 1
}

/// Slow per-character posture changes share the existing render clock and never create timers.
struct PoseAnimation {
    private let seed: UInt64
    private var identity = ""
    private var mode = ""
    private var nextChange = Double.infinity
    private var cycle: UInt64 = 0
    private var target: CharacterPose = .standing
    private var previous: CharacterPose = .standing
    private var changedAt = -Double.infinity
    private var initialOpacity = 1.0

    init(seed: String) {
        self.seed = seed.utf8.reduce(UInt64(14695981039346656037)) { ($0 ^ UInt64($1)) &* 1099511628211 }
    }

    var requested: CharacterPose { target }

    mutating func advance(identity: String, state: String, speaking: Bool, dancing: Bool,
                          available: Set<CharacterPose>, at time: Double, reduced: Bool) -> PoseFrame {
        guard time.isFinite else { return PoseFrame() }
        let nextMode = ["thinking", "working"].contains(state) ? "work" : ["success", "idle"].contains(state) ? "rest" : "blocked"
        if self.identity != identity {
            self.identity = identity; mode = ""; cycle = 0
            target = .standing; previous = .standing; changedAt = -.infinity; initialOpacity = 1
        }
        var desired = target
        if mode != nextMode {
            mode = nextMode
            nextChange = time + (mode == "rest" ? 3 : interval())
            if mode != "rest" || target == .reclining { desired = .standing }
        }
        if dancing || mode == "blocked" {
            desired = .standing
            nextChange = time + interval()
        } else if speaking {
            if desired == .reclining { desired = .standing }
            // Finish the current sentence before changing posture.
            nextChange = max(nextChange, time + (mode == "rest" ? 3 : 1))
        } else if time >= nextChange {
            if mode == "work" {
                desired = target == .seated ? .standing : .seated
                cycle &+= 1; nextChange = time + interval()
            } else if mode == "rest" { desired = .reclining }
        }
        if desired != .standing && !available.contains(desired) { desired = .standing }
        if desired != target {
            let displayed = frame(at: time, reduced: reduced)
            previous = displayed.kind; initialOpacity = displayed.opacity
            target = desired; changedAt = time
        }
        return frame(at: time, reduced: reduced)
    }

    /// Fade through a single silhouette; two different heads never overlap during a pose change.
    func frame(at time: Double, reduced: Bool) -> PoseFrame {
        let t = min(1, max(0, (time - changedAt) / (reduced ? 0.15 : 0.8)))
        if t >= 1 { return PoseFrame(kind: target) }
        let smooth: (Double) -> Double = { $0 * $0 * (3 - 2 * $0) }
        if previous == target { return PoseFrame(kind: target, opacity: initialOpacity + (1 - initialOpacity) * smooth(t)) }
        if t < 0.5 { return PoseFrame(kind: previous, opacity: initialOpacity * (1 - smooth(t * 2))) }
        return PoseFrame(kind: target, opacity: smooth((t - 0.5) * 2))
    }

    private func interval() -> Double {
        let value = (seed &+ cycle &* 0x9E3779B97F4A7C15) &* 0xBF58476D1CE4E5B9
        return 30 + Double(value % 20_001) / 1000
    }
}
