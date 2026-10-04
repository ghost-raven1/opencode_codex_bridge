import Foundation

/// Joint clips are blended with their hand gestures, never selected from a changing clip label during drawing.
enum SkeletalGestures {
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
        guard let style = styles[role] else { return [:] }
        let scan = sin(phase), tap = sin(phase * 6), press = pow(max(0, sin(phase - 0.1 * .pi)), 4)
        var pose = focus(role: role, phase: phase)
        let arm = "forearm-\(style.hand)", shoulder = "upper-arm-\(style.hand)"
        switch kind {
        case "read":
            pose["spine"] = BoneOffset(angle: style.lean + scan * 0.25)
            pose["neck"] = BoneOffset(angle: -style.lean * 0.25 + cos(phase) * 0.25)
            pose[arm] = BoneOffset(angle: -scan * style.arm * 0.7)
        case "search":
            pose["pelvis"] = BoneOffset(x: scan * style.stance * 0.9)
            pose["spine"] = BoneOffset(angle: scan * 1.1)
            pose["chest"] = BoneOffset(angle: -scan * 0.45)
            pose["neck"] = BoneOffset(angle: -scan * 0.3)
        case "edit":
            pose["spine"] = BoneOffset(angle: style.lean + scan * 0.25)
            pose["chest"] = BoneOffset(angle: -style.lean * 0.5 + cos(phase) * 0.3)
            pose[arm] = BoneOffset(angle: -tap * style.arm * 1.5)
            pose[shoulder] = BoneOffset(angle: sin(phase * 3 - 0.2) * style.arm * 0.55)
            if role == "code" { pose["forearm-left"] = BoneOffset(angle: sin(phase * 6 + .pi / 2) * 1.1) }
        case "test":
            pose["pelvis"] = BoneOffset(x: scan * style.stance * 0.35, y: press * 0.4)
            pose["chest"] = BoneOffset(angle: -press * 0.9)
            pose[arm] = BoneOffset(angle: -press * style.arm * 1.8)
            pose["hand-\(style.hand)"] = BoneOffset(angle: press * style.arm * 0.7)
        case "run":
            let launch = pow(max(0, sin(phase + 0.3)), 3)
            pose["pelvis"] = BoneOffset(x: scan * style.stance * 0.25, y: launch * 0.3)
            pose["spine"] = BoneOffset(angle: launch * style.lean)
            pose["chest"] = BoneOffset(angle: -launch * 0.65)
            pose[arm] = BoneOffset(angle: -launch * style.arm * 1.3)
        case "build":
            pose["spine"] = BoneOffset(angle: -scan * style.lean)
            pose["chest"] = BoneOffset(angle: scan * 0.8)
            pose["neck"] = BoneOffset(angle: -cos(phase * 2) * 0.4)
        case "delegate":
            pose["pelvis"] = BoneOffset(x: scan * style.stance * 0.7)
            pose["spine"] = BoneOffset(angle: scan * 0.8)
            pose["chest"] = BoneOffset(angle: -scan * 0.4)
            pose[shoulder] = BoneOffset(angle: -scan * style.arm * 2.5)
            pose[arm] = BoneOffset(angle: scan * style.arm * 1.8)
        default: return [:]
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
