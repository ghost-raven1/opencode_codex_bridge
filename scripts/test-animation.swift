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
        precondition(motion.progress(11, reduced: false) == 1)
        precondition(motion.duration(reduced: true) == 0.15)
        if CommandLine.arguments.count > 1 {
            let directory = URL(fileURLWithPath: CommandLine.arguments[1])
            let library = AnimationLibrary(); library.load(directory)
            var frames = 0
            for name in ["ambient", "entrance", "transform", "working", "thinking", "success", "waiting", "error"] {
                guard let clip = library.clips[name] else { fatalError("Missing clip \(name)") }
                for index in clip.frames.indices {
                    let elapsed = (Double(index) + 0.5) / Double(clip.frames.count) * clip.durationMs / 1000
                    guard let frame = library.sample(name, elapsed: elapsed) else { fatalError("Unreadable \(name) frame \(index)") }
                    precondition(frame.1 == clip.frames[index], "Incorrect timing in \(name)")
                    frames += 1
                }
            }
            precondition(frames >= 60, "Fewer than sixty real body frames per character")
            precondition(NSImage(contentsOf: directory.appendingPathComponent("facial-v3.png"))?.size == NSSize(width: 1024, height: 6912))
            print("PASS all \(frames) body frames per role are reachable through native clip timing, plus18 facial frames")
        }
        print("PASS drawn mouth, blink and expression selection; bounded transitions and reduced motion")
    }
}
