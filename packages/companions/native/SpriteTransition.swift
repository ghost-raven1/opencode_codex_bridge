import AppKit

struct TransitionFrame {
    var opacity = 1.0
    var reveal = 1.0
    var scaleX = 1.0
    var scaleY = 1.0
    var y = 0.0
    var angle = 0.0
    var nod = 0.0
}

/// Gather/reveal/settle, turn/flash, and bow/dissolve use continuous curves and one silhouette.
enum SpriteTransition {
    private static func smooth(_ value: Double) -> Double {
        let p = min(1, max(0, value)); return p * p * (3 - 2 * p)
    }

    static func frame(kind: String, progress: Double, reduced: Bool, initialOpacity: Double? = nil) -> TransitionFrame {
        let p = min(1, max(0, progress))
        if kind == "enter", let opacity = initialOpacity {
            return TransitionFrame(opacity: opacity + (1 - opacity) * smooth(p))
        }
        if reduced {
            return TransitionFrame(opacity: kind == "enter" ? smooth(p) : kind == "leave" ? 1 - smooth(p) : abs(2 * p - 1))
        }
        switch kind {
        case "enter":
            let emerge = smooth((p - 0.08) / 0.60), settle = max(0, (p - 0.55) / 0.45)
            let bounce = sin(settle * 2 * .pi) * (1 - settle)
            return TransitionFrame(opacity: emerge, reveal: smooth(p / 0.72), scaleX: 0.96 + 0.04 * emerge,
                scaleY: 0.96 + 0.04 * emerge, y: -6 * (1 - emerge) + bounce * 3,
                angle: -bounce * 1.2, nod: sin(settle * .pi) * 0.8)
        case "leave":
            let dissolve = smooth((p - 0.15) / 0.85)
            return TransitionFrame(opacity: 1 - dissolve, reveal: 1 - dissolve,
                scaleX: 1 - dissolve * 0.04, scaleY: 1 - dissolve * 0.025,
                y: dissolve * 5, angle: sin(p * .pi) * 1.2, nod: -sin(p * .pi) * 0.9)
        case "turn":
            return TransitionFrame(opacity: 1 - 0.25 * sin(p * .pi), scaleX: 1 - 0.46 * sin(p * .pi),
                                   angle: sin(p * 2 * .pi) * 2)
        default: return TransitionFrame()
        }
    }

    static func apply(angle: Double, in target: NSRect) {
        let pivot = NSPoint(x: target.midX, y: target.minY + target.height * 16 / 384)
        let transform = NSAffineTransform()
        transform.translateX(by: pivot.x, yBy: pivot.y); transform.rotate(byDegrees: angle)
        transform.translateX(by: -pivot.x, yBy: -pivot.y); transform.concat()
    }

    static func drawBehind(_ rect: NSRect, kind: String, progress: Double, accent: NSColor, reduced: Bool) {
        guard !reduced else { return }
        let p = min(1, max(0, progress)), pulse = sin(p * .pi)
        if kind == "turn" {
            let flash = pow(max(0, 1 - abs(p - 0.5) / 0.20), 2)
            accent.withAlphaComponent(flash * 0.22).setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: -6 * flash, dy: 0)).fill()
        } else {
            let ground = rect.minY + rect.height * 16 / 384
            let ring = NSBezierPath(ovalIn: NSRect(x: rect.midX - rect.width * 0.38 * pulse, y: ground - 3,
                                                  width: rect.width * 0.76 * pulse, height: 6 + pulse * 6))
            accent.withAlphaComponent(pulse * 0.5).setStroke(); ring.lineWidth = 1; ring.stroke()
        }
    }

    /// Pixel trails follow the reveal edge; they never blur the interior artwork.
    static func drawFront(_ rect: NSRect, kind: String, progress: Double, accent: NSColor, seed: Int, reduced: Bool) {
        guard !reduced else { return }
        let p = min(1, max(0, progress)), alpha = pow(sin(p * .pi), 2)
        let reveal = frame(kind: kind, progress: p, reduced: false).reveal
        for n in 0..<28 {
            let phase = Double(n) * 2.399 + Double(seed % 17)
            let stagger = Double(n % 7) / 7, size = n % 5 == 0 ? 3.0 : 2.0
            let x: Double, y: Double
            if kind == "enter" {
                let spread = (1 - p) * 18
                x = rect.midX + sin(phase) * (rect.width * 0.32 + spread)
                y = rect.minY + rect.height * reveal + cos(phase) * 7 - stagger * 16
            } else if kind == "leave" {
                x = rect.midX + sin(phase) * rect.width * 0.33 + p * 18 * sin(phase * 0.3)
                y = rect.minY + rect.height * reveal + stagger * 26 * p + p * 12
            } else {
                let angle = phase + p * .pi * 2
                x = rect.midX + cos(angle) * rect.width * 0.49
                y = rect.midY + sin(angle) * rect.height * 0.44
            }
            accent.withAlphaComponent(alpha * (0.4 + stagger * 0.4)).setFill()
            NSRect(x: x.rounded(), y: y.rounded(), width: size, height: size).fill()
        }
    }
}
