import Foundation

/// Joint clips are blended with their hand gestures, never selected from a changing clip label during drawing.
enum SkeletalGestures {
    /// One smooth prepare/act/settle beat drives both cutout hands and the corresponding bones.
    struct ActionBeat {
        let ready: Double, prepare: Double, scan: Double, trace: Double
        let tap: Double, other: Double, press: Double, confirm: Double

        init(phase: Double) {
            let p = max(0, phase / (2 * .pi)).truncatingRemainder(dividingBy: 1)
            ready = Self.window(p, 0, 0.2, 0.78, 1)
            prepare = Self.window(p, 0, 0.12, 0.16, 0.28)
            let travel = Self.ease((p - 0.18) / 0.6)
            scan = ready * (travel * 2 - 1)
            trace = ready * sin(travel * 2 * .pi)
            tap = Self.window(p, 0.22, 0.4, 0.4, 0.58)
            other = Self.window(p, 0.41, 0.59, 0.59, 0.77)
            press = Self.window(p, 0.18, 0.34, 0.46, 0.64)
            confirm = Self.window(p, 0.58, 0.76, 0.84, 1)
        }

        private static func ease(_ value: Double) -> Double {
            let t = min(1, max(0, value)); return t * t * (3 - 2 * t)
        }
        private static func window(_ p: Double, _ start: Double, _ rise: Double, _ fall: Double, _ end: Double) -> Double {
            ease((p - start) / (rise - start)) * (1 - ease((p - fall) / (end - fall)))
        }
    }

    private struct Style {
        let stance: Double, lean: Double, arm: Double
        let hand: String
    }
    private static let styles: [String: Style] = [
        "lead": Style(stance: 0.65, lean: 0.45, arm: 0.85, hand: "right"),
        "code": Style(stance: 0.5, lean: 0.8, arm: 0.7, hand: "right"),
        "research": Style(stance: 0.85, lean: 0.5, arm: 0.65, hand: "right"),
        "review": Style(stance: 0.35, lean: 0.3, arm: 0.9, hand: "right"),
        "designer": Style(stance: 1, lean: 0.6, arm: 1, hand: "left"),
        "devops": Style(stance: 0.4, lean: 0.55, arm: 1.2, hand: "right"),
        "tester": Style(stance: 0.7, lean: 0.75, arm: 0.9, hand: "right")
    ]

    static func focus(role: String, phase: Double) -> [String: BoneOffset] {
        guard let style = styles[role] else { return [:] }
        var pose = ["pelvis": BoneOffset(x: sin(phase) * style.stance * 0.4),
                    "spine": BoneOffset(angle: style.lean + sin(phase) * 0.5),
                    "chest": BoneOffset(angle: -style.lean * 0.6 + sin(phase + 0.45) * 0.4),
                    "neck": BoneOffset(angle: -sin(phase + 0.65) * 0.25)]
        for side in ["left", "right"] {
            let gain = side == style.hand ? style.arm : style.arm * 0.45
            let beat = phase * (role == "code" || role == "tester" ? 4 : 1) + (side == "left" ? 0 : .pi / 2)
            pose["upper-arm-\(side)"] = BoneOffset(angle: sin(phase + 0.3) * gain * 0.5)
            pose["forearm-\(side)"] = BoneOffset(angle: -sin(beat) * gain)
            pose["hand-\(side)"] = BoneOffset(angle: sin(beat - 0.25) * gain * 0.45)
        }
        return pose
    }

    static func action(role: String, kind: String, phase: Double) -> [String: BoneOffset] {
        guard let style = styles[role], phase.isFinite else { return [:] }
        let beat = ActionBeat(phase: phase), side = style.hand
        let arm = "forearm-\(side)", shoulder = "upper-arm-\(side)", wrist = "hand-\(side)"
        let support = side == "left" ? "right" : "left"
        var pose = ["pelvis": BoneOffset(x: beat.scan * style.stance * 0.35),
                    "spine": BoneOffset(angle: beat.ready * style.lean),
                    "chest": BoneOffset(angle: -beat.ready * style.lean * 0.55),
                    "neck": BoneOffset(angle: -beat.confirm * 0.45),
                    "upper-arm-\(support)": BoneOffset(angle: beat.ready * style.arm * 0.25),
                    "forearm-\(support)": BoneOffset(angle: -beat.ready * style.arm * 0.3)]
        switch kind {
        case "read":
            pose["neck"] = BoneOffset(angle: -beat.ready * 0.55 + beat.scan * 0.3)
            pose[shoulder] = BoneOffset(angle: -beat.ready * style.arm * 0.8)
            pose[arm] = BoneOffset(angle: (beat.ready * 1.7 + beat.other * 0.6) * style.arm)
            pose[wrist] = BoneOffset(angle: -beat.other * style.arm * 0.6)
        case "search":
            pose["pelvis"] = BoneOffset(x: beat.scan * style.stance * 0.8)
            pose["spine"] = BoneOffset(angle: beat.scan * 1.4)
            pose["chest"] = BoneOffset(angle: -beat.scan * 0.65)
            pose["neck"] = BoneOffset(angle: -beat.scan * 0.5 - beat.confirm * 0.2)
            pose[shoulder] = BoneOffset(angle: -beat.scan * style.arm * 1.5)
            pose[arm] = BoneOffset(angle: beat.scan * style.arm * 1.9)
            pose[wrist] = BoneOffset(angle: beat.confirm * style.arm * 0.5)
        case "edit":
            pose[shoulder] = BoneOffset(angle: (-beat.prepare * 0.9 + beat.trace * 0.6) * style.arm)
            pose[arm] = BoneOffset(angle: (beat.prepare * 0.7 - beat.tap * 2.2) * style.arm)
            pose[wrist] = BoneOffset(angle: beat.tap * style.arm * 0.9)
        case "test":
            pose["chest"] = BoneOffset(angle: -beat.press * 1.2 + beat.confirm * 0.3)
            pose[shoulder] = BoneOffset(angle: beat.prepare * style.arm * 0.7)
            pose[arm] = BoneOffset(angle: -beat.press * style.arm * 2.3)
            pose[wrist] = BoneOffset(angle: beat.press * style.arm * 0.9)
        case "run":
            pose["spine"] = BoneOffset(angle: beat.press * style.lean)
            pose["neck"] = BoneOffset(angle: beat.prepare * 0.3 - beat.confirm * 0.7)
            pose[shoulder] = BoneOffset(angle: -beat.prepare * style.arm)
            pose[arm] = BoneOffset(angle: -beat.press * style.arm * 2 + beat.confirm * style.arm * 0.5)
            pose[wrist] = BoneOffset(angle: beat.press * style.arm * 0.65)
        case "build":
            pose["spine"] = BoneOffset(angle: -beat.scan * style.lean)
            pose["chest"] = BoneOffset(angle: beat.scan * 0.85)
            pose["neck"] = BoneOffset(angle: -beat.confirm * 0.6)
            pose[shoulder] = BoneOffset(angle: -beat.ready * style.arm)
            pose[arm] = BoneOffset(angle: beat.ready * style.arm * 2.2)
            pose[wrist] = BoneOffset(angle: -beat.scan * style.arm * 0.5)
        case "delegate":
            pose["pelvis"] = BoneOffset(x: beat.scan * style.stance * 0.7)
            pose["spine"] = BoneOffset(angle: beat.scan * 0.9)
            pose["chest"] = BoneOffset(angle: -beat.scan * 0.4)
            pose[shoulder] = BoneOffset(angle: -beat.ready * style.arm * 2.8)
            pose[arm] = BoneOffset(angle: beat.ready * style.arm * 2.1)
            pose[wrist] = BoneOffset(angle: beat.confirm * style.arm)
        default: return [:]
        }
        switch role {
        case "lead": pose[wrist] = (pose[wrist] ?? BoneOffset()).adding(BoneOffset(angle: beat.confirm * 0.5))
        case "code":
            if kind == "edit" {
                pose["forearm-left"] = BoneOffset(angle: -beat.other * 2.2)
                pose["forearm-right"] = BoneOffset(angle: -beat.tap * 2.2)
                pose["hand-left"] = BoneOffset(angle: beat.other * 0.8)
                pose["hand-right"] = BoneOffset(angle: beat.tap * 0.8)
            }
        case "research":
            if kind == "read" {
                pose[arm] = BoneOffset(angle: beat.ready * 0.9 + beat.other * 1.8)
                pose[wrist] = BoneOffset(angle: -beat.other * 0.9)
            }
        case "review": pose[wrist] = (pose[wrist] ?? BoneOffset()).adding(BoneOffset(angle: -beat.tap * 0.6))
        case "designer":
            if kind == "edit" {
                pose[arm] = BoneOffset(angle: -beat.trace * 2.4 + beat.ready * 0.4)
                pose[wrist] = BoneOffset(angle: beat.trace * 1.4)
            }
        case "devops": pose[wrist] = (pose[wrist] ?? BoneOffset()).adding(BoneOffset(angle: beat.trace * 1.2))
        case "tester":
            if kind == "edit" || kind == "test" {
                pose["forearm-left"] = BoneOffset(angle: -beat.other * 1.8)
                pose["hand-left"] = BoneOffset(angle: beat.other * 0.7)
                pose["hand-right"] = BoneOffset(angle: beat.tap * 0.9)
            }
        default: break
        }
        return pose
    }

    static func rest(role: String, scan: Double, nod: Double, variant: Int) -> [String: BoneOffset] {
        guard let style = styles[role] else { return [:] }
        var pose = ["pelvis": BoneOffset(x: scan * style.stance * 0.8),
                    "spine": BoneOffset(angle: scan * 0.5), "chest": BoneOffset(angle: -scan * 0.25)]
        if variant == 1 { pose["neck"] = BoneOffset(angle: -scan * 0.65) }
        if variant == 2 {
            pose["chest"] = BoneOffset(angle: -scan * 0.5)
            pose["upper-arm-\(style.hand)"] = BoneOffset(angle: -scan * style.arm)
            pose["forearm-\(style.hand)"] = BoneOffset(angle: scan * style.arm * 1.4)
        }
        if variant == 3 { pose["chest"] = BoneOffset(angle: nod * 0.45); pose["neck"] = BoneOffset(angle: -nod * 0.2) }
        return pose
    }

    static func reaction(role: String, state: String, scan: Double, nod: Double, amount: Double) -> [String: BoneOffset] {
        guard let style = styles[role] else { return [:] }
        var pose = ["pelvis": BoneOffset(x: scan * style.stance * 0.35),
                    "spine": BoneOffset(angle: scan * 0.6), "chest": BoneOffset(angle: -scan * 0.25),
                    "neck": BoneOffset(angle: -nod * 0.3)]
        switch state {
        case "waiting":
            pose["chest"] = BoneOffset(angle: -amount * 0.7)
            pose["upper-arm-\(style.hand)"] = BoneOffset(angle: -amount * style.arm * 1.2)
            pose["forearm-\(style.hand)"] = BoneOffset(angle: amount * style.arm)
        case "success":
            pose["pelvis"] = BoneOffset(y: amount * 0.45)
            pose["spine"] = BoneOffset(angle: -scan * 0.7)
            pose["chest"] = BoneOffset(angle: nod * 0.8)
            pose["upper-arm-\(style.hand)"] = BoneOffset(angle: -amount * style.arm * 1.5)
        case "error":
            pose["spine"] = BoneOffset(angle: amount * style.lean)
            pose["chest"] = BoneOffset(angle: -amount * 0.9)
            pose["upper-arm-left"] = BoneOffset(angle: -amount * 0.7)
            pose["upper-arm-right"] = BoneOffset(angle: amount * 0.7)
        default: break
        }
        return pose
    }

    static func interaction(role: String, direction: Double, reach: Double, hand: Double) -> [String: BoneOffset] {
        guard let style = styles[role] else { return [:] }
        return ["pelvis": BoneOffset(x: direction * reach * style.stance * 0.5),
                "spine": BoneOffset(angle: direction * reach * 0.6),
                "chest": BoneOffset(angle: -direction * reach * 0.4),
                "neck": BoneOffset(angle: -direction * reach * 0.3),
                "upper-arm-\(style.hand)": BoneOffset(angle: -hand * style.arm * 1.6),
                "forearm-\(style.hand)": BoneOffset(angle: hand * style.arm * 1.2)]
    }

    /// Counter-moving chest/shoulders carry the measured beat through the body rather than rotating a card.
    static func dance(role: String, phase: Double) -> [String: BoneOffset] {
        guard let style = styles[role] else { return [:] }
        let sway = sin(phase), hit = pow(max(0, sin(phase)), 2), pulse = sin(phase * 2)
        var pose = ["pelvis": BoneOffset(x: sway * style.stance * 0.7),
                    "spine": BoneOffset(angle: sway * style.arm),
                    "chest": BoneOffset(angle: -sway * style.arm * 0.7),
                    "neck": BoneOffset(angle: pulse * 0.35),
                    "upper-arm-left": BoneOffset(angle: -sway * style.arm),
                    "upper-arm-right": BoneOffset(angle: sway * style.arm),
                    "forearm-left": BoneOffset(angle: pulse * style.arm * 1.5),
                    "forearm-right": BoneOffset(angle: -pulse * style.arm * 1.5)]
        switch role {
        case "code": pose["chest"] = BoneOffset(angle: -pulse * 1.1)
        case "research": pose["spine"] = BoneOffset(angle: sway * 0.7); pose["forearm-left"] = BoneOffset(angle: pulse * 0.4)
        case "review": pose["chest"] = BoneOffset(angle: -hit * 1.2); pose["neck"] = BoneOffset(angle: pulse * 0.2)
        case "designer": pose["chest"] = BoneOffset(angle: sin(phase + 0.4) * 1.2); pose["hand-left"] = BoneOffset(angle: pulse * 1.4)
        case "devops": pose["spine"] = BoneOffset(angle: -hit * 1.1); pose["forearm-right"] = BoneOffset(angle: pulse * 2)
        case "tester": pose["chest"] = BoneOffset(angle: pulse * 1.2); pose["hand-right"] = BoneOffset(angle: -pulse)
        default: break
        }
        return pose
    }
}
