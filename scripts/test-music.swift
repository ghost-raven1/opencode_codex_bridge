import AppKit

@main struct MusicTests {
    static let rate = 8000.0
    static func track(seconds: Double, waveform: (Double) -> Double) -> MusicBeatState {
        var tracker = MusicRhythm(sampleRate: rate)
        let samples = (0..<Int(seconds * rate)).map { Float(waveform(Double($0) / rate)) }
        samples.withUnsafeBufferPointer { buffer in
            var offset = 0
            while offset < buffer.count {
                let length = min(offset % 2 == 0 ? 317 : 701, buffer.count - offset)
                tracker.consume(buffer.baseAddress! + offset, count: length, stride: 1, frame: Int64(offset))
                offset += length
            }
        }
        return tracker.state
    }
    static func music(_ bpm: Double, gain: Double = 1) -> (Double) -> Double {
        { time in
            let phase = time.truncatingRemainder(dividingBy: 60 / bpm)
            let kick = phase < 0.08 ? exp(-phase * 55) * sin(time * 2 * .pi * 90) * 0.65 : 0
            return (kick + sin(time * 2 * .pi * 330) * 0.025) * gain
        }
    }
    static func main() {
        for bpm in [80.0, 120, 180] {
            let state = track(seconds: 12, waveform: music(bpm))
            precondition(state.confidence >= 0.75 && abs(60 / state.period - bpm) < 3, "Beat tracking failed at \(bpm) BPM: \(state)")
            let expected = floor(state.anchor / (60 / bpm)) * (60 / bpm)
            precondition(abs(state.anchor - expected) < 0.035, "Onset is not aligned with the audio attack")
        }
        let quietMusic = track(seconds: 10, waveform: music(120, gain: 0.1))
        precondition(quietMusic.confidence >= 0.75, "Quiet audible rhythm was lost")
        let silence = track(seconds: 10) { _ in 0 }
        let tone = track(seconds: 10) { time in sin(time * 2 * .pi * 440) * 0.3 }
        let transient = track(seconds: 10) { time in time < 0.05 ? sin(time * 2 * .pi * 200) * 0.5 : 0 }
        precondition(silence.confidence == 0 && tone.confidence == 0 && transient.confidence == 0, "Silence, a tone or one transient cannot establish a beat")
        var gate = MusicClassificationGate()
        gate.update(music: 0.8, speech: 0.8, at: 0)
        gate.update(music: 0.95, speech: 0.8, at: 1)
        precondition(gate.allowance(at: 1.4) == 0, "Speech must veto ambiguous music")
        gate.update(music: 0.9, speech: 0.1, at: 2)
        precondition(gate.allowance(at: 2.5) == 0, "One classification cannot start dancing")
        gate.update(music: 0.9, speech: 0.1, at: 2.75)
        precondition(gate.allowance(at: 3.2) > 0.9)
        gate.update(music: 0.1, speech: 0.9, at: 3.5)
        precondition(gate.allowance(at: 3.7) > 0 && gate.allowance(at: 4.4) == 0, "Speech/quiet release must fade")
        precondition(gate.allowance(at: 10) == 0, "Stale classification remained active")
        // Speaker-to-microphone music yielded 0.53/0.56 despite a stable 120 BPM beat.
        var roomGate = MusicClassificationGate()
        roomGate.update(music: 0.53, speech: 0.03, at: 0)
        precondition(roomGate.allowance(at: 0.5) == 0, "One room classification started a dance")
        roomGate.update(music: 0.56, speech: 0.03, at: 0.75)
        precondition(roomGate.allowance(at: 1.2) > 0.9, "Audible music remained blocked by the classifier threshold")
        roomGate.update(music: 0.31, speech: 0.03, at: 1.5)
        precondition(roomGate.allowance(at: 1.8) > 0.9, "A modest confidence dip interrupted established music")
        roomGate.update(music: 0.56, speech: 0.42, at: 2.25)
        precondition(roomGate.allowance(at: 3.1) == 0, "Hysteresis bypassed the speech veto")
        roomGate.update(music: 0.53, speech: 0.03, at: 4)
        roomGate.update(music: 0.56, speech: 0.03, at: 4.75)
        roomGate.update(music: 0.31, speech: 0.03, at: 8.25)
        precondition(roomGate.allowance(at: 8.8) == 0 && roomGate.label == "quiet", "Stale capture reused the lower hold threshold")
        var uncertainGate = MusicClassificationGate()
        uncertainGate.update(music: 0.31, speech: 0.03, at: 0)
        uncertainGate.update(music: 0.31, speech: 0.03, at: 0.75)
        precondition(uncertainGate.allowance(at: 1.2) == 0, "Low confidence opened a fresh music gate")
        var vocalGate = MusicClassificationGate()
        vocalGate.update(music: 0.95, speech: 0.8, vocals: 0.85, at: 0)
        vocalGate.update(music: 0.95, speech: 0.8, vocals: 0.85, at: 0.75)
        precondition(vocalGate.allowance(at: 1.2) > 0.9 && vocalGate.label == "music", "Confident vocal music was vetoed as speech")
        var spokenGate = MusicClassificationGate()
        spokenGate.update(music: 0.1, speech: 0.95, vocals: 0.85, at: 0)
        spokenGate.update(music: 0.1, speech: 0.95, vocals: 0.85, at: 0.75)
        precondition(spokenGate.allowance(at: 1.2) == 0, "Rhythmic/sung speech without confident music opened the dance gate")
        var beat = quietMusic; beat.allowance = 1
        precondition(beat.strength(at: beat.measuredAt) > 0)
        precondition(beat.strength(at: beat.measuredAt + 1.1) == 0, "A stopped audio stream must release the dance")
        beat = MusicBeatState(anchor: 10, period: 0.5, sequence: 10, confidence: 1, audibleAt: 10.12, allowance: 1, measuredAt: 10.12)
        let styles = ["lead", "code", "research", "review", "designer", "devops", "tester"]
        let poses = styles.map { MusicMotion.pose(beat: beat, time: 10.12, column: 0, rig: $0, reduced: false) }
        precondition(Set(poses.map { "\($0.x),\($0.y),\($0.angle),\($0.headAngle)" }).count == 7, "Character dance styles are not distinct")
        for (index, name) in styles.enumerated() {
            let reduced = MusicMotion.pose(beat: beat, time: 10.12, column: index % 4, rig: name, reduced: true)
            precondition(reduced.strength == 0 && reduced.x == 0 && reduced.y == 0 && reduced.angle == 0)
            let absent = MusicMotion.pose(beat: nil, time: 10.12, column: index % 4, rig: name, reduced: false)
            precondition(absent.strength == 0)
            var twice = beat; twice.period = 0.25; twice.measuredAt = 10.06; twice.audibleAt = 10.06
            let faster = MusicMotion.pose(beat: twice, time: 10.06, column: index % 4, rig: name, reduced: false)
            precondition(abs(faster.y - poses[index].y) < 0.001, "Dance clock is not proportional to measured tempo")
        }
        let queue = MusicWorkGate(capacity: 3)
        precondition(queue.reserve() && queue.reserve() && queue.reserve() && !queue.reserve())
        queue.release(); precondition(queue.reserve())
        queue.close(); queue.release()
        precondition(queue.isClosed && !queue.reserve(), "Stopped analysis accepted another queued audio buffer")
        var diagnostics = MusicDiagnosticGate()
        precondition(diagnostics.accept(state: "music", tempo: 120, at: 1))
        precondition(!diagnostics.accept(state: "music", tempo: 121, at: 2), "Minor BPM jitter flooded diagnostics")
        precondition(!diagnostics.accept(state: "quiet", at: 1.1), "Per-buffer state jitter flooded diagnostics")
        precondition(diagnostics.accept(state: "quiet", at: 2.1))
        precondition(diagnostics.accept(state: "unavailable", at: 2.2), "Capture errors must be visible immediately")
        precondition(!diagnostics.accept(state: "unavailable", at: 2.3), "Duplicate errors flooded diagnostics")
        print("PASS measured 80/120/180 BPM and onset alignment, quiet music, no tone/transient beat, speech veto, gate/fade, seven synchronized styles, reduced motion and bounded stopped queue")
    }
}
