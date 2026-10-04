import AppKit

@main struct ChoreographyQA {
    @MainActor static func main() throws {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.accessory)
        let assets = URL(fileURLWithPath: CommandLine.arguments[1]), output = URL(fileURLWithPath: CommandLine.arguments[2])
        let expansion = assets.appendingPathComponent("expansion")
        let library = PoseRigLibrary(directory: expansion)
        let roles = ["lead", "code", "research", "review", "designer", "devops", "tester"]
        for role in roles { for pose in CharacterPose.allCases where pose.isDrawn {
            precondition(library.rig("\(role)/\(pose.rawValue)") != nil, "Invalid native rig: \(role)/\(pose.rawValue)")
        } }
        let panel = NSPanel(contentRect: NSRect(x: 80, y: 80, width: 1176, height: 330),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        let view = CharacterView(frame: panel.contentView!.bounds); panel.contentView = view
        view.atlas = NSImage(contentsOf: assets.appendingPathComponent("team-atlas.png"))!
        view.loadRigs(directory: expansion)
        let entries = roles.enumerated().map { index, role in
            Character(id: "qa-\(role)", column: min(3, index), label: role.uppercased(), state: "working",
                      rig: role, name: role.capitalized, invocationID: "qa", activity: "read")
        }
        var count = 0, signatures = Set<String>()
        func save(_ name: String) throws {
            let path = output.appendingPathComponent(name + ".png")
            precondition(view.snapshot(path.path), "Empty native snapshot: \(name)")
            let data = try Data(contentsOf: path), bitmap = NSBitmapImageRep(data: data)!
            var colored = 0
            for y in stride(from: 30, to: bitmap.pixelsHigh - 60, by: 3) {
                for x in stride(from: 0, to: bitmap.pixelsWide, by: 3) {
                    if let pixel = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB), pixel.saturationComponent > 0.15 { colored += 1 }
                }
            }
            precondition(colored > 150, "Blank graphics: \(name); use native window-system permissions")
            count += 1
        }
        func setup(at time: Double = 1000, actors: [Character]? = nil) {
            view.snapshotTime = time; view.musicBeat = nil; view.speaker = nil; view.auditPose = nil
            view.auditReduced = false; view.replace(actors ?? entries, animated: false)
        }
        // Every real view on both backgrounds, with proportional scale and Retina backing.
        for background in ["light", "dark"] { for size in [0.5, 1.0, 2.0] {
            panel.setContentSize(NSSize(width: 1176 * size, height: 330 * size))
            view.setFrameSize(panel.contentView!.frame.size); view.setBoundsSize(NSSize(width: 1176, height: 330))
            for pose in CharacterPose.allCases where pose.isDrawn {
                setup(); view.auditPose = pose; view.snapshotBackground = background; view.snapshotTime = 1002.3
                try save("pose-\(pose.rawValue)-\(background)-\(size)")
            }
        } }
        // Mixed heads must keep their own silhouette and meet the outfit's measured neck pivot.
        for headOffset in 1...3 {
            let mixed = (0..<4).map { body in
                Character(id: "qa-mixed-\(body)", column: body, label: "MIX \(body + 1)", state: "working",
                          headColumn: (body + headOffset) % 4, bodyColumn: body, name: "Mix\(body + 1)", activity: "read")
            }
            for background in ["light", "dark"] { for size in [0.5, 1.0, 2.0] {
                panel.setContentSize(NSSize(width: 672 * size, height: 330 * size))
                view.setFrameSize(panel.contentView!.frame.size); view.setBoundsSize(NSSize(width: 672, height: 330))
                for pose in CharacterPose.allCases where pose.isDrawn {
                    setup(actors: mixed); view.auditPose = pose; view.snapshotBackground = background; view.snapshotTime = 1002.3
                    let group = headOffset == 1 ? "mixed" : "mixed\(headOffset)"
                    try save("\(group)-\(pose.rawValue)-\(background)-\(size)")
                }
            } }
        }
        panel.setContentSize(NSSize(width: 1176, height: 330))
        view.setFrameSize(panel.contentView!.frame.size); view.setBoundsSize(NSSize(width: 1176, height: 330))
        setup(at: 0); view.snapshotBackground = "dark"
        for frame in 0..<192 {
            let time = Double(frame) / 24, sequence = Int(floor(time / 0.5))
            view.musicBeat = MusicBeatState(anchor: Double(sequence) * 0.5, period: 0.5, sequence: sequence,
                confidence: 1, audibleAt: time, allowance: 1, measuredAt: time)
            view.snapshotTime = time; view.tick()
            for actor in entries { signatures.insert("\(actor.rig!)/\(view.displayPosture(for: actor, at: time).kind.rawValue)") }
            try save(String(format: "dance-%03d", frame))
        }
        precondition(signatures.filter { $0.contains("/dance-") }.count == 28, "Some authored dances were never shown")
        view.speaker = entries[3].id; view.snapshotTime = 8.5; view.tick(); view.snapshotTime = 9.5; view.tick()
        precondition(view.displayPosture(for: entries[3], at: 9.5).kind == .standing, "Narration retained a neutral dance face")
        try save("dance-speech-return")
        view.auditReduced = true; view.snapshotTime = 10; view.tick()
        precondition(entries.allSatisfy { !view.displayPosture(for: $0, at: 10).kind.isDance }, "Reduce Motion retained dance keyframes")
        try save("dance-reduced")
        let building = entries.map { actor -> Character in var result = actor; result.activity = "build"; return result }
        setup(at: 0, actors: building)
        for frame in 0..<72 {
            view.snapshotTime = Double(frame) / 24; view.tick()
            try save(String(format: "work-turn-%03d", frame))
        }
        setup(at: 0)
        for time in [0.0, 0.4, 1.0] { view.snapshotTime = time; view.tick() }
        var narrator = entries[0]; narrator.rig = "code"; narrator.column = 1; narrator.label = "CODE"
        view.snapshotTime = 1.2; view.update(narrator); view.speaker = narrator.id
        view.mouthLevel = 0.7; view.mouthUntil = 3
        for (name, time) in [("start", 1.2), ("frontal", 1.8), ("new-role", 2.1)] {
            view.snapshotTime = time; view.tick()
            if name == "frontal" {
                precondition(view.displayPosture(for: narrator, at: time).kind == .standing,
                             "Outgoing role retained a neutral head during narration")
            }
            try save("role-speech-\(name)")
        }
        // State-specific layered gestures use all seven roles and never depend on rare idle timers.
        for state in StateMotion.kinds {
            let reacting = entries.map { actor -> Character in
                var result = actor; result.state = state; result.activity = nil; result.invocationID = "state-\(state)"; return result
            }
            for background in ["light", "dark"] {
                setup(at: 1000, actors: reacting); view.auditPose = .standing; view.snapshotBackground = background
                for elapsed in [0.4, 1.0, 2.0, 4.0] {
                    view.snapshotTime = 1000 + elapsed; view.tick()
                    try save("state-\(state)-\(background)-\(elapsed)")
                }
            }
        }
        let report: [String: Any] = ["passed": true, "snapshots": count, "roles": roles,
            "layeredPoses": 112, "dancePosesUsed": 28, "mixedIdentities": 12,
            "stateGestures": 28,
            "scales": [0.5, 1, 2], "backingScale": panel.backingScaleFactor,
            "microphone": false, "speech": false]
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            .write(to: output.appendingPathComponent("report.json"))
        print("PASS \(count) AppKit snapshots, 112 layered rigs, 12 mixed identities, 28 dance poses, Retina scale, narration and reduced motion")
    }
}
