import Foundation

/// A measured beat clock. Fading is based on the last real onset and audible audio, not idle animation time.
struct MusicBeatState {
    var anchor: Double = 0
    var period: Double = 0.5
    var sequence: Int = 0
    var confidence: Double = 0
    var audibleAt: Double = -.infinity
    var allowance: Double = 0
    var measuredAt: Double = 0
    var classification = "quiet"
    var classificationConfidence: Double = 0

    func strength(at time: Double) -> Double {
        let beatFade = min(1, max(0, (period * 1.8 + 0.8 - (time - anchor)) / 0.8))
        let silenceFade = min(1, max(0, (0.9 - (time - audibleAt)) / 0.7))
        let stalledFade = min(1, max(0, (1 - (time - measuredAt)) / 0.7))
        return min(1, max(0, confidence * allowance * beatFade * silenceFade * stalledFade))
    }
}

/// Two confident music classifications are required; speech wins ambiguous classifications.
struct MusicClassificationGate {
    private var consecutive = 0
    private var open = false
    private var changedAt = -Double.infinity
    private var lastResult = -Double.infinity
    private(set) var label = "quiet"
    private(set) var confidence: Double = 0
    mutating func update(music: Double, speech: Double, vocals: Double = 0, at time: Double) {
        // Singing is a distinct classifier signal; ordinary rhythmic speech alone cannot open this gate.
        let vocalMusic = vocals.isFinite && vocals >= 0.65 && music >= 0.7 && music > speech + 0.12
        let instrumental = music >= 0.65 && speech < 0.4 && music > speech + 0.25
        let positive = music.isFinite && speech.isFinite && (instrumental || vocalMusic)
        label = positive ? "music" : speech >= 0.4 ? "speech" : "quiet"
        confidence = min(1, max(0, label == "speech" ? speech : music.isFinite ? music : 0))
        if time - lastResult > 3 { consecutive = 0; open = false }
        lastResult = time
        if positive {
            consecutive += 1
            if consecutive >= 2 && !open { open = true; changedAt = time }
        } else {
            consecutive = 0
            if open { open = false; changedAt = time }
        }
    }
    func allowance(at time: Double) -> Double {
        guard changedAt.isFinite else { return 0 }
        let freshness = min(1, max(0, (3 - (time - lastResult)) / 0.8))
        return freshness * (open ? min(1, max(0, (time - changedAt) / 0.4)) : max(0, 1 - (time - changedAt) / 0.8))
    }
}

/// Coalesce beat diagnostics; audio callbacks must never become a per-buffer event stream.
struct MusicDiagnosticGate {
    private var signature = "", lastTime = -Double.infinity
    mutating func accept(state: String, tempo: Double = 0, at time: Double) -> Bool {
        let next = "\(state):\(Int((tempo / 5).rounded()))"
        guard next != signature, time - lastTime >= 1 || ["stopped", "unavailable"].contains(state) else { return false }
        signature = next; lastTime = time; return true
    }
}

/// RMS onset novelty plus a stable interval consensus; one transient or a steady tone has no tempo.
struct MusicRhythm {
    let sampleRate: Double
    private var sum = 0.0, count = 0
    private var previousEnergy = 0.0, noise = 0.0
    private var onsets: [Double] = []
    private var expectedFrame: Int64?
    private(set) var state = MusicBeatState()

    mutating func consume(_ samples: UnsafePointer<Float>, count length: Int, stride: Int, frame: Int64) {
        guard length > 0, stride > 0, sampleRate.isFinite, sampleRate > 0 else { return }
        if let expectedFrame, expectedFrame != frame {
            sum = 0; count = 0; previousEnergy = 0; noise = 0; onsets = []; state = MusicBeatState()
        }
        expectedFrame = frame + Int64(length)
        let window = max(1, Int(sampleRate / 100))
        for index in 0..<length {
            let value = Double(samples[index * stride])
            sum += value.isFinite ? value * value : 0; count += 1
            if count == window {
                measure(sqrt(sum / Double(count)), time: Double(frame + Int64(index)) / sampleRate)
                sum = 0; count = 0
            }
        }
    }

    private mutating func measure(_ energy: Double, time: Double) {
        state.measuredAt = time
        if energy > 0.002 { state.audibleAt = time }
        let novelty = max(0, energy - previousEnergy)
        previousEnergy = energy; noise = noise * 0.97 + novelty * 0.03
        guard energy > 0.003, novelty > max(0.001, noise * 3.2),
              time - (onsets.last ?? -.infinity) >= 0.23 else { return }
        onsets.append(time); if onsets.count > 10 { onsets.removeFirst() }
        guard onsets.count >= 5 else { return }
        let intervals = zip(onsets.dropFirst(), onsets).map { next, previous -> Double in
            let value = next - previous
            return value < 0.3 ? value * 2 : value
        }.filter { $0 >= 0.3 && $0 <= 1 }
        guard intervals.count >= 4 else { return }
        let ordered = intervals.sorted(), period = ordered[ordered.count / 2]
        let matching = intervals.filter { abs($0 - period) <= period * 0.12 }
        let confidence = Double(matching.count) / Double(onsets.count - 1)
        guard matching.count >= 4, confidence >= 0.75 else { return }
        let measured = matching.reduce(0, +) / Double(matching.count)
        if state.confidence == 0 || time - state.anchor >= measured * 0.7 {
            let skipped = state.confidence > 0 ? max(1, Int(((time - state.anchor) / measured).rounded())) : 1
            state.sequence += skipped; state.anchor = time; state.period = measured; state.confidence = confidence
        }
    }
}

/// Bounded pending audio work; closing invalidates queued buffers before a new capture session starts.
final class MusicWorkGate {
    private let lock = NSLock()
    private var count = 0, closed = false
    let capacity: Int
    init(capacity: Int = 24) { self.capacity = capacity }
    func reserve() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !closed && count < capacity else { return false }
        count += 1; return true
    }
    func release() { lock.lock(); count = max(0, count - 1); lock.unlock() }
    func close() { lock.lock(); closed = true; lock.unlock() }
    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }
}
