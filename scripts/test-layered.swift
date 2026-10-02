import AppKit

@main struct LayeredTests {
    static func main() {
        for state in ["idle", "thinking", "working", "waiting", "success", "error"] {
            for seed in 0..<4 {
                var positions = Set<String>()
                for frame in 0..<120 {
                    let time = Double(frame) / 24
                    let pose = LayeredMotion.pose(state: state, time: time, gestureElapsed: time,
                        speaking: true, reduced: false, seed: seed)
                    precondition(pose.bodyScaleY.isFinite && abs(pose.bodyScaleY - 1) <= 0.0041)
                    precondition(pose.headAngle.isFinite && abs(pose.headAngle) < 4)
                    precondition(pose.headX.isFinite && pose.headY.isFinite && abs(pose.headY) < 3)
                    positions.insert("\(pose.headX),\(pose.headY),\(pose.headAngle)")
                }
                precondition(positions.count >= 60, "Layer motion froze or repeated a few full-body frames")
            }
        }
        for time in [0.0, 10.0, 100.0] {
            let reduced = LayeredMotion.pose(state: "working", time: time, gestureElapsed: time, speaking: true, reduced: true, seed: 1)
            precondition(reduced.bodyScaleY == 1 && reduced.headX == 0 && reduced.headY == 0 && reduced.headAngle == 0)
        }
        var captions = CaptionState()
        precondition(captions.text(visible: ["a"]).isEmpty)
        captions.update("a", text: "Публичная реплика до начала синтеза")
        captions.update("b", text: "Другая задача")
        precondition(captions.text(visible: ["a"]) == "Публичная реплика до начала синтеза")
        precondition(captions.text(visible: ["a", "b"]) == "Другая задача")
        precondition(captions.text(visible: ["a", "b"], preferred: "a") == "Публичная реплика до начала синтеза")
        precondition(captions.text(visible: ["b"], preferred: "a") == "Другая задача")
        captions.update("b", text: "")
        precondition(captions.text(visible: ["a", "b"]) == "Публичная реплика до начала синтеза")
        captions.update("a", text: "")
        precondition(captions.text(visible: ["a", "b"]).isEmpty)
        print("PASS continuous bounded body/head layers, reduced motion and audio-independent public captions")
    }
}
