import AppKit

@main struct AnimationTests {
    static func main() {
        var mouth = Set<Int>()
        for level in [0.0, 0.1, 0.7] {
            for i in 0..<24 {
                mouth.insert(FacialMotion.rows(state: "idle", speaking: true, open: level > 0,
                    level: level, time: Double(i) / 8, blinkElapsed: nil)[0])
            }
        }
        precondition(mouth == Set(0..<8), "Not all eight drawn mouth forms are reachable")
        let blink = (0..<6).map { FacialMotion.rows(state: "idle", speaking: false, open: false,
            level: 0, time: 0, blinkElapsed: Double($0) * 0.05 + 0.001).last! }
        precondition(blink == Array(8..<14), "Blink sequence skipped or crossed clip bounds")
        for (state, expected) in [("success", 14), ("error", 15), ("thinking", 16), ("working", 16), ("waiting", 17)] {
            precondition(FacialMotion.rows(state: state, speaking: false, open: false, level: 0,
                time: 0, blinkElapsed: nil) == [expected], "Wrong task expression")
        }
        let motion = Motion(kind: "turn", start: 10)
        precondition(motion.progress(9, reduced: false) == 0)
        precondition(motion.progress(10.7, reduced: false) < 0.51)
        precondition(motion.progress(11.4, reduced: false) == 1)
        precondition(motion.duration(reduced: true) == 0.15)
        if CommandLine.arguments.count > 1 {
            let directory = URL(fileURLWithPath: CommandLine.arguments[1])
            precondition(NSImage(contentsOf: directory.appendingPathComponent("facial-v3.png"))?.size == NSSize(width: 1024, height: 6912))
            print("PASS layered facial atlas contains 18 registered mouth, blink and expression frames per role")
        }
        print("PASS drawn mouth, blink and expression selection; bounded transitions and reduced motion")
    }
}
