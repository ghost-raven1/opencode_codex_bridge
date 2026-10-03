import AppKit

@main struct TransitionTests {
    static func main() {
        for kind in ["enter", "turn", "leave"] {
            var frames = Set<String>()
            var last: TransitionFrame?
            for n in 0...240 {
                let frame = SpriteTransition.frame(kind: kind, progress: Double(n) / 240, reduced: false)
                precondition((0...1).contains(frame.opacity) && (0...1).contains(frame.reveal))
                precondition((0.5...1.01).contains(frame.scaleX) && (0.95...1.01).contains(frame.scaleY))
                precondition(abs(frame.y) <= 6.1 && abs(frame.angle) <= 2.1 && abs(frame.nod) <= 1)
                if let last {
                    precondition(abs(frame.y - last.y) < 0.3 && abs(frame.opacity - last.opacity) < 0.04, "Transition snapped between intermediate frames")
                }
                frames.insert("\(frame.opacity):\(frame.y):\(frame.scaleX):\(frame.scaleY):\(frame.reveal):\(frame.angle)")
                last = frame
                let reduced = SpriteTransition.frame(kind: kind, progress: Double(n) / 240, reduced: true)
                precondition(reduced.scaleX == 1 && reduced.scaleY == 1 && reduced.y == 0 && reduced.angle == 0 && reduced.reveal == 1)
            }
            precondition(frames.count > 180, "Transition is a coarse flipbook")
        }
        let arrived = SpriteTransition.frame(kind: "enter", progress: 1, reduced: false)
        let gone = SpriteTransition.frame(kind: "leave", progress: 1, reduced: false)
        let turned = SpriteTransition.frame(kind: "turn", progress: 1, reduced: false)
        precondition(arrived.opacity == 1 && arrived.scaleX == 1 && arrived.scaleY == 1 && abs(arrived.y) < 0.0001)
        precondition(gone.opacity == 0 && gone.reveal == 0)
        precondition(turned.opacity > 0.999 && turned.scaleX > 0.999)
        for p in [0.0, 0.2, 0.5, 0.9, 1.0] {
            let resumed = SpriteTransition.frame(kind: "enter", progress: p, reduced: false, initialOpacity: 0.4)
            precondition(resumed.opacity >= 0.4 && resumed.reveal == 1 && resumed.scaleX == 1, "Cancelled departure restarted the reveal from zero")
        }
        print("PASS gather/reveal/settle, role turn/flash, bow/dissolve, continuous intermediate frames and reduced motion")
    }
}
