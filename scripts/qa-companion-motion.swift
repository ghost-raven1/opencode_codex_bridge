import AppKit

// Only this QA target can select a clip. Production continues to use each character's seed.
enum MotionAudit { static var variant: Int?; static var progress: Double? }

@main struct MotionQA {
    static func require(_ condition: Bool, _ message: String) {
        if !condition { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1) }
    }
    @MainActor static func main() throws {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.accessory)
        let assets = URL(fileURLWithPath: CommandLine.arguments[1]), output = URL(fileURLWithPath: CommandLine.arguments[2])
        let roles = ["lead", "code", "research", "review", "designer", "devops", "tester"]
        let names = ["Акира", "Юино", "Микана", "Рикоми", "Хару", "Наори", "Коэми"]
        let panel = NSPanel(contentRect: NSRect(x: 100, y: 200, width: 1176, height: 330),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false; panel.backgroundColor = .clear
        let view = CharacterView(frame: panel.contentView!.bounds); panel.contentView = view
        view.atlas = NSImage(contentsOf: assets.appendingPathComponent("team-atlas.png"))!
        view.loadRigs(directory: assets.appendingPathComponent("expansion"))
        var snapshots: [[String: Any]] = []
        func character(_ role: String, id: String? = nil, state: String = "working", parent: String? = nil) -> Character {
            let index = roles.firstIndex(of: role)!
            return Character(id: id ?? "qa-\(role)", column: min(index, 3), label: role.uppercased(), state: state,
                             rig: role, name: names[index], parentID: parent, invocationID: "qa-one")
        }
        func setup(_ entries: [Character], at time: Double = 1000, animated: Bool = false) {
            MotionAudit.variant = nil; MotionAudit.progress = nil
            view.auditGesture = nil; view.auditVariant = nil; view.auditReduced = false
            view.auditPose = .standing; view.auditDepth = nil; view.speaker = nil
            view.auditResetTeam()
            panel.setContentSize(NSSize(width: CGFloat(entries.count) * 168, height: 330))
            view.setFrameSize(panel.contentView!.frame.size); view.setBoundsSize(NSSize(width: CGFloat(entries.count) * 168, height: 330))
            view.snapshotTime = time; view.replace(entries, animated: animated)
        }
        func scale(_ scale: Double) {
            let size = view.bounds.size
            panel.setContentSize(NSSize(width: size.width * scale, height: size.height * scale))
            view.setFrameSize(panel.contentView!.frame.size); view.setBoundsSize(size)
        }
        func save(_ name: String, background: String = "dark", scale: Double = 1, allowEmpty: Bool = false) throws {
            view.snapshotBackground = background
            let path = output.appendingPathComponent(name + ".png")
            require(view.snapshot(path.path), "Failed native snapshot \(name)")
            let bitmap = NSBitmapImageRep(data: try Data(contentsOf: path))!
            var coloured = 0
            for y in stride(from: 0, to: Int(Double(bitmap.pixelsHigh) * 0.80), by: 3) {
                for x in stride(from: 0, to: bitmap.pixelsWide, by: 3) {
                    if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB), color.saturationComponent > 0.12 { coloured += 1 }
                }
            }
            require(allowEmpty || coloured > 20, "Empty sprites: run AppKit QA outside the restricted graphics sandbox: \(name)")
            snapshots.append(["name": name, "path": path.path, "background": background, "scale": scale,
                              "backingScale": panel.backingScaleFactor, "time": view.snapshotTime ?? 0, "colouredSamples": coloured])
            if snapshots.count % 100 == 0 { print("Rendered \(snapshots.count) native frames") }
        }
        let entries = roles.map { character($0) }
        let phases = [0.0, 0.08, 0.16, 0.25, 0.4, 0.55, 0.72, 0.9, 1.0]
        for background in ["light", "dark"] {
            setup([])
            // Exercise production entry motions without also scheduling seven greeting pairs.
            panel.setContentSize(NSSize(width: 1176, height: 330)); view.setFrameSize(panel.contentView!.frame.size)
            view.setBoundsSize(NSSize(width: 1176, height: 330))
            for entry in entries { view.update(entry, animateInteractions: false) }
            for (index, phase) in phases.enumerated() {
                view.snapshotTime = 1000 + phase * 1.65
                try save("enter-\(index)-\(background)", background: background, allowEmpty: phase < 0.4)
            }
            view.snapshotTime = 1003
            for (index, entry) in entries.enumerated() {
                var turned = character(roles[(index + 1) % roles.count], id: entry.id); turned.name = entry.name
                view.update(turned)
            }
            for (index, phase) in phases.enumerated() {
                view.snapshotTime = 1003 + phase * 1.4; try save("turn-\(index)-\(background)", background: background)
            }
            view.snapshotTime = 1005; view.tick()
            for entry in entries { view.remove(entry.id) }
            for (index, phase) in phases.enumerated() {
                view.snapshotTime = 1005 + phase * 0.9
                try save("leave-\(index)-\(background)", background: background, allowEmpty: phase > 0.72)
            }
        }
        for background in ["light", "dark"] { for variant in 0..<4 {
            setup(entries); view.snapshotTime = 1002
            for index in 0..<12 {
                MotionAudit.variant = variant; MotionAudit.progress = Double(index) / 12
                view.snapshotTime = 1002 + Double(index) / 12 * 4.7
                try save("work-\(variant)-\(index)-\(background)", background: background)
            }
            setup(roles.map { character($0, state: "idle") }); view.auditVariant = variant
            for index in 0..<12 {
                view.auditGesture = Double(index) / 12 * 4.8
                view.snapshotTime = 1002 + Double(index) / 12 * 4.8
                try save("idle-\(variant)-\(index)-\(background)", background: background)
            }
        } }
        // Real tool clips, every authored posture: inspect hand/prop/neck seams at several phases.
        for background in ["light", "dark"] { for kind in ActionMotion.kinds { for pose in CharacterPose.allCases {
            setup(entries.map { entry in var actor = entry; actor.activity = kind; return actor })
            view.auditPose = pose
            for index in 0..<6 {
                view.snapshotTime = 1002 + Double(index)
                view.tick()
                try save("action-\(kind)-\(pose.rawValue)-\(index)-\(background)", background: background)
            }
        } } }
        // Caption ownership, word reveal and long-text layout at proportional scale.
        let captionText = "Проверяю изменения в коде. Сейчас запускаю тесты, затем проверю результат и связанные сценарии."
        for background in ["light", "dark"] { for size in [0.5, 1.0, 2.0] { for owner in 0..<4 {
            setup(Array(entries.prefix(4))); view.bubbleOwner = entries[owner].id; view.bubble = captionText
            let width = view.bounds.width, height = view.contentHeight(width: width)
            panel.setContentSize(NSSize(width: width, height: height)); view.setFrameSize(panel.contentView!.frame.size)
            view.setBoundsSize(NSSize(width: width, height: height)); scale(size)
            let range = (captionText as NSString).range(of: "Сейчас")
            view.speechBubble.reveal(until: NSMaxRange(range), word: range, reduced: true)
            view.layoutBubble(width: width)
            require(view.speechBubble.frame.minX >= 0 && view.speechBubble.frame.maxX <= width, "Caption outside panel")
            require(view.speechBubble.laidOutCharacters == (captionText as NSString).length, "Caption text lost")
            try save("caption-owner-\(owner)-\(background)-\(size)", background: background, scale: size)
            view.bubble = ""; _ = view.contentHeight(width: width)
        } } }
        // Extreme proportional scaling, all three rigs, soft edges and static volume.
        for background in ["light", "dark"] { for size in [0.5, 1.0, 2.0] { for pose in CharacterPose.allCases {
            setup(roles.map { character($0, state: "idle") }); scale(size)
            view.auditPose = pose; view.auditReduced = true; view.snapshotTime = 1002
            try save("depth-\(pose.rawValue)-\(background)-\(size)", background: background, scale: size)
        } } }
        // Perspective extremes must preserve all joints in every authored posture and mixed face.
        for background in ["light", "dark"] { for pose in CharacterPose.allCases {
            setup(entries); view.auditPose = pose; view.snapshotTime = 1002
            for (index, turn) in [-0.65, -0.32, 0, 0.32, 0.65].enumerated() {
                view.auditDepth = DepthPose(turn: turn, headTurn: turn)
                try save("volume-\(pose.rawValue)-\(index)-\(background)", background: background)
            }
            for offset in [1, 2] {
                setup((0..<4).map { Character(id: "mixed-\($0)", column: $0, label: "MIXED", state: "working",
                    headColumn: ($0 + offset) % 4, bodyColumn: $0, name: names[$0]) })
                view.auditPose = pose; view.auditDepth = DepthPose(turn: 0.65, headTurn: 0.7); view.snapshotTime = 1002
                try save("volume-mixed-\(pose.rawValue)-\(offset)-\(background)", background: background)
            }
        } }
        // Actual linked events, reciprocal gestures, serial handoff/result and speaking mouth.
        for (pair, roles) in [["lead", "code"], ["code", "tester"], ["research", "review"], ["designer", "devops"]].enumerated() {
            for kind in [TeamActionKind.greeting, .handoff, .result, .support] {
                let parent = character(roles[0], id: "parent"), child = character(roles[1], id: "child", parent: kind == .greeting ? nil : "parent")
                if kind == .handoff || kind == .greeting {
                    setup([parent]); view.update(child)
                    panel.setContentSize(NSSize(width: 336, height: 330)); view.setFrameSize(panel.contentView!.frame.size)
                    view.setBoundsSize(NSSize(width: 336, height: 330))
                } else {
                    setup([parent, child]); var done = child; done.state = kind == .result ? "success" : "error"; view.update(done)
                }
                let action = view.auditActions.first { $0.kind == kind }!
                for index in 0..<12 {
                    view.snapshotTime = action.start + Double(index) / 12 * kind.duration
                    try save("team-\(pair)-\(kind.rawValue)-\(index)")
                }
                view.speaker = "child"; view.mouthUntil = action.end + 1; view.mouthLevel = 0.7
                view.snapshotTime = action.start + kind.duration * 0.6
                try save("team-\(pair)-\(kind.rawValue)-speaking")
            }
        }
        // Reduced motion still completes without particles or a transformed silhouette.
        for kind in ["enter", "turn", "leave"] {
            setup(entries, animated: kind == "enter"); view.auditReduced = true
            if kind == "turn" { for (index, entry) in entries.enumerated() { view.update(character(roles[(index + 1) % roles.count], id: entry.id)) } }
            if kind == "leave" { for entry in entries { view.remove(entry.id) } }
            view.snapshotTime = 1000.075; try save("reduced-\(kind)", allowEmpty: kind == "turn")
        }
        let report: [String: Any] = ["passed": true, "snapshots": snapshots, "roles": roles,
            "clips": ["work": 28, "idle": 28, "teamKinds": 4], "depthViews": 42, "audio": false, "microphone": false]
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: output.appendingPathComponent("report.json"))
        print("PASS \(snapshots.count) native animation frames: seven roles, 28 work/28 idle clips, paired team actions, three poses, Retina scaling and reduced motion")
    }
}
