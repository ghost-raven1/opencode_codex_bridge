import AppKit

struct Character {
    var id: String
    var column: Int
    var label: String
    var state: String
    var headColumn: Int
    var bodyColumn: Int
    init(id: String, column: Int, label: String, state: String, headColumn: Int? = nil, bodyColumn: Int? = nil) {
        self.id = id; self.column = min(max(column, 0), 3); self.label = label; self.state = state
        self.headColumn = min(max(headColumn ?? column, 0), 3)
        self.bodyColumn = min(max(bodyColumn ?? column, 0), 3)
    }
    func looksLike(_ other: Character) -> Bool {
        column == other.column && headColumn == other.headColumn && bodyColumn == other.bodyColumn
    }
}

struct Motion {
    var kind: String
    var start: TimeInterval
    var previous: Character?
    func duration(reduced: Bool) -> Double { reduced ? 0.15 : kind == "enter" ? 0.6 : kind == "turn" ? 0.7 : 0.45 }
    func progress(_ now: TimeInterval, reduced: Bool) -> Double { min(1, max(0, (now - start) / duration(reduced: reduced))) }
}

/// Each character has its own irregular blink and prop gesture schedule.
struct AmbientMotion {
    var blinkAt: TimeInterval
    var gestureAt: TimeInterval
    var gestureStart: TimeInterval = -.infinity
    init(now: TimeInterval) {
        blinkAt = now + Double.random(in: 2.3...5.8)
        gestureAt = now + Double.random(in: 8...15)
    }
    mutating func advance(_ now: TimeInterval) {
        if now > blinkAt + 0.30 { blinkAt = now + Double.random(in: 2.3...5.8) }
        if now >= gestureAt { gestureStart = now; gestureAt = now + Double.random(in: 8...15) }
    }
}

struct AnimationClip: Decodable {
    var atlas: String
    var frames: [Int]
    var durationMs: Double
}

/// Drawn mouth shapes follow audio energy; these are visual states, not phoneme inference.
enum FacialMotion {
    static func rows(state: String, speaking: Bool, open: Bool, level: Double,
                     time: Double, blinkElapsed: Double?) -> [Int] {
        var rows: [Int]
        if speaking {
            rows = [!open ? 0 : level < 0.2 ? 1 : 2 + Int(max(0, time) * 8) % 6]
        } else {
            rows = [["success": 14, "error": 15, "working": 16, "thinking": 16, "waiting": 17][state] ?? 0]
        }
        if let elapsed = blinkElapsed, elapsed >= 0, elapsed < 0.30 {
            rows.append(8 + min(5, Int(elapsed / 0.30 * 6)))
        }
        return rows
    }
}

/// Optional drawn clips fall back to the original atlas when artwork is unavailable.
final class AnimationLibrary {
    var images: [String: NSImage] = [:]
    var clips: [String: AnimationClip] = [:]
    func load(_ directory: URL) {
        struct Manifest: Decodable { var clips: [String: AnimationClip] }
        images = [:]; clips = [:]
        for name in ["animation-v2.json", "animation-v3.json"] {
            if let data = try? Data(contentsOf: directory.appendingPathComponent(name)),
               let manifest = try? JSONDecoder().decode(Manifest.self, from: data) {
                clips.merge(manifest.clips) { _, newer in newer }
            }
        }
        for name in Set(clips.values.map { $0.atlas }) {
            if let image = NSImage(contentsOf: directory.appendingPathComponent(name)) { images[name] = image }
        }
    }
    func sample(_ name: String, elapsed: Double) -> (NSImage, Int, Int)? {
        guard let clip = clips[name], !clip.frames.isEmpty, clip.durationMs > 0,
              let image = images[clip.atlas], image.size.width == 1024,
              image.size.height.truncatingRemainder(dividingBy: 384) == 0 else { return nil }
        let index = min(clip.frames.count - 1, max(0, Int(elapsed * 1000 / clip.durationMs * Double(clip.frames.count))))
        let rows = Int(image.size.height / 384), row = clip.frames[index]
        guard row >= 0, row < rows else { return nil }
        return (image, row, rows)
    }
}
