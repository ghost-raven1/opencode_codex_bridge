import AppKit

struct Character {
    var id: String
    var column: Int
    var label: String
    var state: String
    var headColumn: Int
    var bodyColumn: Int
    var rig: String?
    var name: String?
    var parentID: String?
    var invocationID: String?
    init(id: String, column: Int, label: String, state: String, headColumn: Int? = nil, bodyColumn: Int? = nil,
         rig: String? = nil, name: String? = nil, parentID: String? = nil, invocationID: String? = nil) {
        self.id = id; self.column = min(max(column, 0), 3); self.label = label; self.state = state
        self.headColumn = min(max(headColumn ?? column, 0), 3)
        self.bodyColumn = min(max(bodyColumn ?? column, 0), 3)
        self.rig = rig
        self.parentID = parentID; self.invocationID = invocationID
        let cleanName = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.name = cleanName.isEmpty ? nil : String(cleanName.prefix(10))
    }
    func looksLike(_ other: Character) -> Bool {
        column == other.column && headColumn == other.headColumn && bodyColumn == other.bodyColumn && rig == other.rig
    }
    var motionSeed: Int { Int(id.utf8.reduce(UInt64(14695981039346656037)) { ($0 ^ UInt64($1)) &* 1099511628211 } % 97) }
}

struct Motion {
    var kind: String
    var start: TimeInterval
    var previous: Character?
    var initialOpacity: Double? = nil
    func duration(reduced: Bool) -> Double { reduced ? 0.15 : kind == "enter" ? (initialOpacity == nil ? 1.65 : 0.45) : kind == "turn" ? 1.4 : 0.9 }
    func progress(_ now: TimeInterval, reduced: Bool) -> Double { min(1, max(0, (now - start) / duration(reduced: reduced))) }
}

/// Each character has its own irregular blink and head gesture schedule.
struct AmbientMotion {
    var blinkAt: TimeInterval
    var gestureAt: TimeInterval
    var gestureStart: TimeInterval = -.infinity
    var gestureIndex = 0
    init(now: TimeInterval, gestureInterval: ClosedRange<Double> = 8...15) {
        blinkAt = now + Double.random(in: 2.3...5.8)
        gestureAt = now + Double.random(in: gestureInterval)
    }
    mutating func advance(_ now: TimeInterval, gestureInterval: ClosedRange<Double> = 8...15) {
        if now > blinkAt + 0.30 { blinkAt = now + Double.random(in: 2.3...5.8) }
        if now >= gestureAt {
            gestureStart = now; gestureIndex = (gestureIndex + 1) % 4
            gestureAt = now + Double.random(in: gestureInterval)
        }
    }
}

/// Drawn mouth shapes follow audio energy; these are visual states, not phoneme inference.
enum FacialMotion {
    static func rows(state: String, speaking: Bool, open: Bool, level: Double,
                     time: Double, blinkElapsed: Double?) -> [Int] {
        var rows: [Int]
        if speaking {
            rows = [!open ? 0 : level < 0.2 ? 1 : 2 + Int(max(0, time) * 4) % 6]
        } else {
            rows = [["success": 14, "error": 15, "working": 16, "thinking": 16, "waiting": 17][state] ?? 0]
        }
        if let elapsed = blinkElapsed, elapsed >= 0, elapsed < 0.30 {
            rows.append(8 + min(5, Int(elapsed / 0.30 * 6)))
        }
        return rows
    }
}
