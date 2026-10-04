import AppKit

@main struct PoseTests {
    static let available: Set<CharacterPose> = [.seated, .reclining]
    static func step(_ pose: inout PoseAnimation, _ time: Double, state: String = "working", identity: String = "code-name",
                     speaking: Bool = false, dancing: Bool = false, available: Set<CharacterPose> = available,
                     reduced: Bool = false) -> PoseFrame {
        pose.advance(identity: identity, state: state, speaking: speaking, dancing: dancing,
                     available: available, at: time, reduced: reduced)
    }
    static func main() {
        _ = NSApplication.shared
        try! lazyPoseLoading()
        var a = PoseAnimation(seed: "agent-a"), b = PoseAnimation(seed: "agent-b")
        _ = step(&a, 0); _ = step(&b, 0)
        var switchesA: [Double] = [], switchesB: [Double] = []
        var lastA = CharacterPose.standing, lastB = CharacterPose.standing
        for frame in 1...4_800 {
            let time = Double(frame) / 24
            let x = step(&a, time), y = step(&b, time)
            precondition(x.kind != .reclining && y.kind != .reclining, "Working character reclined")
            if x.kind != lastA { switchesA.append(time); lastA = x.kind }
            if y.kind != lastB { switchesB.append(time); lastB = y.kind }
        }
        precondition(switchesA.count >= 3 && switchesB.count >= 3, "Work never used the seated rig")
        precondition(switchesA != switchesB, "Independent companions changed poses in lockstep")
        for times in [switchesA, switchesB] {
            precondition((30...51).contains(times[0]))
            for pair in zip(times, times.dropFirst()) { precondition((30...51).contains(pair.1 - pair.0), "Rapid pose flipbook") }
        }
        var resting = PoseAnimation(seed: "rest")
        _ = step(&resting, 0)
        _ = step(&resting, 2, state: "success")
        precondition(step(&resting, 4.9, state: "success").kind == .standing)
        _ = step(&resting, 5, state: "success")
        precondition(step(&resting, 6, state: "success").kind == .reclining)
        // Speech, permission and music revoke resting; finishing speech does not change identity.
        for block in ["speech", "waiting", "dance"] {
            var copy = resting
            _ = step(&copy, 6.1, state: block == "waiting" ? "waiting" : "idle", speaking: block == "speech", dancing: block == "dance")
            let final = step(&copy, 7.1, state: block == "waiting" ? "waiting" : "idle", speaking: block == "speech", dancing: block == "dance")
            precondition(final.kind == .standing, "Blocked reclining: \(block)")
        }
        // A new task resets the schedule; role/name replacement cannot inherit the old reclining pose.
        _ = step(&resting, 6.1)
        precondition(step(&resting, 7).kind == .standing)
        precondition(step(&resting, 20, identity: "review-new-name").kind == .standing)
        precondition(step(&resting, 49, identity: "review-new-name").kind == .standing)
        var interrupted = PoseAnimation(seed: "interrupt")
        _ = step(&interrupted, 0, state: "idle"); _ = step(&interrupted, 3, state: "idle")
        let fading = step(&interrupted, 3.2, state: "idle")
        let retargeted = step(&interrupted, 3.2, state: "working")
        precondition(abs(fading.opacity - retargeted.opacity) < 0.000001, "Retargeting flashed the old silhouette")
        precondition(abs(fading.y - retargeted.y) < 0.000001 && abs(fading.angle - retargeted.angle) < 0.000001 &&
                     abs(fading.scaleY - retargeted.scaleY) < 0.000001, "Intermediate posture snapped on interruption")
        let calm = interrupted.frame(at: 3.25, reduced: true)
        precondition(calm.y == 0 && calm.angle == 0 && calm.scaleY == 1, "Enabling Reduce Motion retained an old posture offset")
        precondition(step(&interrupted, 4.1).kind == .standing)
        var reduced = PoseAnimation(seed: "reduced")
        _ = step(&reduced, 0, state: "idle", reduced: true); _ = step(&reduced, 3, state: "idle", reduced: true)
        let settled = step(&reduced, 3.16, state: "idle", reduced: true)
        precondition(settled.kind == .reclining && settled.opacity == 1, "Reduced motion did not finish its short fade")
        var missing = PoseAnimation(seed: "missing")
        for time in stride(from: 0.0, through: 200, by: 0.1) {
            let sample = step(&missing, time, state: time < 100 ? "working" : "idle", available: [])
            precondition(sample.kind == .standing && sample.opacity == 1, "Missing pose caused a blank transition")
        }
        print("PASS independent slow poses, work/rest restrictions, interruptions, new identities, reduced motion and missing fallback")
    }

    /// Reading optional pose metadata must not eagerly decode all fourteen facial atlases.
    static func lazyPoseLoading() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("codexbridge-pose-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        func image(_ name: String, height: Int) throws {
            let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 256, pixelsHigh: height,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                bytesPerRow: 0, bitsPerPixel: 0)!
            memset(bitmap.bitmapData!, 0, bitmap.bytesPerRow * height)
            try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent(name))
        }
        func definition(_ file: String) -> [String: Any] {
            ["layers": [["id": "body", "file": file, "pivot": [128, 368], "motion": "body", "amplitudeDegrees": 0],
                        ["id": "head", "file": file, "parent": "body", "pivot": [128, 120], "motion": "head", "amplitudeDegrees": 1]],
             "face": ["file": "face.png", "frameHeight": 384, "frames": LayeredRig.faceFrames],
             "motion": ["breathSeconds": 4.8, "gestureSeconds": 3.6, "gestureIntervalSeconds": [8, 15]]]
        }
        let manifest: [String: Any] = ["version": 1, "canvas": ["width": 256, "height": 384], "characters": [
            "code/seated": definition("layer.png"), "code/reclining": definition("missing.png")]]
        try JSONSerialization.data(withJSONObject: manifest).write(to: directory.appendingPathComponent("poses.json"))
        let library = PoseRigLibrary(directory: directory)
        precondition(library.loadCount == 0 && library.contains("code/seated"), "Pose startup decoded PNGs")
        // Create image files only after library construction: metadata access cannot require pixels.
        try image("layer.png", height: 384); try image("face.png", height: 384 * 18)
        let first = library.rig("code/seated")!
        precondition(library.loadCount == 1)
        for _ in 0..<100 { precondition(library.rig("code/seated") === first) }
        precondition(library.loadCount == 1, "Repeated pose rendering decoded its images again")
        precondition(library.rig("code/reclining") == nil && !library.contains("code/reclining"))
        for _ in 0..<100 { precondition(library.rig("code/reclining") == nil) }
        precondition(library.loadCount == 2, "Invalid optional pose was retried every frame")
        precondition(LayeredRig.load(directory: directory).isEmpty, "Optional manifest replaced standing art")
        precondition(PoseRigLibrary(directory: directory.appendingPathComponent("missing")).loadCount == 0)
        // Exercise real CharacterView selection: a mixed head must never turn into the outfit's head.
        let standing: [String: Any] = ["version": 1, "canvas": ["width": 256, "height": 384],
            "characters": ["code": definition("layer.png"), "research": definition("layer.png")]]
        try JSONSerialization.data(withJSONObject: standing).write(to: directory.appendingPathComponent("manifest.json"))
        let view = CharacterView(frame: NSRect(x: 0, y: 0, width: 168, height: 330))
        view.loadRigs(directory: directory); view.snapshotTime = 0
        var mixed = Character(id: "mixed", column: 1, label: "CODE", state: "working", headColumn: 2, bodyColumn: 1, name: "Каэми")
        view.update(mixed)
        for time in stride(from: 0.0, through: 60, by: 1) {
            precondition(view.posture(for: mixed, at: time).kind == .standing, "Missing mixed head changed appearance")
        }
        let bad = Character(id: "bad", column: 1, label: "CODE", state: "idle")
        view.snapshotTime = 0; view.update(bad)
        let rejected = view.posture(for: bad, at: 4)
        precondition(rejected.kind == .standing && rejected.opacity == 1, "Invalid pose made the standing sprite disappear")
        let complete: [String: Any] = ["version": 1, "canvas": ["width": 256, "height": 384], "characters": [
            "code/seated": definition("layer.png"), "research/seated": definition("layer.png"),
            "code/reclining": definition("layer.png"), "research/reclining": definition("layer.png")]]
        try JSONSerialization.data(withJSONObject: complete).write(to: directory.appendingPathComponent("poses.json"))
        view.loadRigs(directory: directory); view.snapshotTime = 0; view.replace([mixed], animated: false)
        _ = view.posture(for: mixed, at: 60)
        precondition(view.posture(for: mixed, at: 60.81).kind == .seated, "Complete mixed pose was not selected")
        let nextRole = Character(id: mixed.id, column: 0, label: "LEAD", state: "working", name: mixed.name)
        view.snapshotTime = 60.9; view.update(nextRole)
        precondition(view.displayPosture(for: nextRole, at: 60.91).kind == .seated,
                     "Old seated body jumped to standing before its role transition")
        let latestRole = Character(id: mixed.id, column: 3, label: "REVIEW", state: "working", name: mixed.name)
        view.snapshotTime = 61.0; view.update(latestRole)
        precondition(view.displayPosture(for: latestRole, at: 61.01).kind == .seated,
                     "Repeated role update forgot the visible previous pose")
        precondition(view.displayPosture(for: latestRole, at: 61.8).kind == .standing)
        view.remove(latestRole.id, immediately: true); view.snapshotTime = 61.81; view.update(latestRole)
        precondition(view.displayPosture(for: latestRole, at: 61.82).kind == .standing,
                     "Removal retained the previous role's seated posture")
        view.snapshotTime = 0; view.replace([mixed], animated: false)
        _ = view.posture(for: mixed, at: 60)
        let midpoint = view.posture(for: mixed, at: 60.4)
        precondition(midpoint.opacity < 0.0001)
        view.snapshotTime = 60.4; view.update(nextRole)
        let resumedFade = view.displayPosture(for: nextRole, at: 60.5)
        precondition(resumedFade.opacity > 0.05 && resumedFade.opacity < 1 && resumedFade.kind == .seated,
                     "Role change froze an invisible pose midpoint instead of continuing the fade")
        let laterFade = view.displayPosture(for: nextRole, at: 60.6)
        precondition(laterFade.opacity > resumedFade.opacity, "Old pose fade did not continue during role transition")
        view.snapshotTime = 60.6; view.update(latestRole)
        let repeatedFade = view.displayPosture(for: latestRole, at: 60.6)
        precondition(abs(repeatedFade.opacity - laterFade.opacity) < 0.000001 && repeatedFade.kind == laterFade.kind,
                     "Repeated role change restarted or froze the visible pose fade")
        view.snapshotTime = 0; view.replace([mixed], animated: false)
        _ = view.posture(for: mixed, at: 60); _ = view.posture(for: mixed, at: 60.81)
        view.speaker = mixed.id; mixed.state = "idle"; view.snapshotTime = 61; view.update(mixed)
        precondition(view.posture(for: mixed, at: 65).kind != .reclining, "Speaking character reclined")
        view.speaker = nil; _ = view.posture(for: mixed, at: 68)
        precondition(view.posture(for: mixed, at: 68.81).kind == .reclining)
        mixed.state = "working"; view.snapshotTime = 69; view.update(mixed)
        precondition(view.posture(for: mixed, at: 69.81).kind == .standing)
        precondition(view.characters[0].name == "Каэми" && view.characters[0].headColumn == 2 && view.characters[0].bodyColumn == 1,
                     "Pose transition reset the character's identity")
        view.remove(mixed.id, immediately: true); view.snapshotTime = 100; view.tick()
        precondition(view.characters.isEmpty, "Pose selection resurrected an empty view")
        view.update(mixed); precondition(view.posture(for: mixed, at: 100).kind == .standing, "Removed character kept a previous pose")
        // A role transition must advance its outgoing neutral-only posture when narration begins.
        var authored = definition("layer.png")
        var neutralFace = authored["face"] as! [String: Any]; neutralFace["neutralOnly"] = true; authored["face"] = neutralFace
        let choreography: [String: Any] = ["version": 1, "canvas": ["width": 256, "height": 384],
            "characters": ["code/work-three-quarter": authored]]
        try JSONSerialization.data(withJSONObject: choreography).write(to: directory.appendingPathComponent("choreography.json"))
        view.loadRigs(directory: directory); view.snapshotTime = 0
        let oldNarrator = Character(id: "narrator", column: 1, label: "CODE", state: "working", rig: "code", activity: "read")
        view.replace([oldNarrator], animated: false)
        for time in [0.0, 0.4, 1.0] { _ = view.posture(for: oldNarrator, at: time) }
        precondition(view.posture(for: oldNarrator, at: 1.2).kind == .workThreeQuarter)
        let newNarrator = Character(id: oldNarrator.id, column: 2, label: "RESEARCH", state: "working", rig: "research", activity: "read")
        view.snapshotTime = 1.2; view.update(newNarrator); view.speaker = newNarrator.id
        view.tick()
        let returning = view.displayPosture(for: newNarrator, at: 1.2)
        precondition(returning.kind == .workThreeQuarter && returning.opacity == 1,
                     "Narration snapped the outgoing authored silhouette")
        view.snapshotTime = 1.8; view.tick()
        let frontal = view.displayPosture(for: newNarrator, at: 1.8)
        precondition(frontal.kind == .standing && frontal.opacity == 1,
                     "Role change froze a neutral-only head throughout the first spoken words")
        view.speaker = nil
        // A fresh invocation on the same character starts its own posture schedule; metadata updates do not.
        var nextTask = oldNarrator
        view.snapshotTime = 10; nextTask.invocationID = "task-a"; view.replace([nextTask], animated: false)
        _ = view.posture(for: nextTask, at: 10.4)
        precondition(view.posture(for: nextTask, at: 11).kind == .workThreeQuarter)
        view.snapshotTime = 11; view.update(nextTask)
        precondition(view.posture(for: nextTask, at: 11).kind == .workThreeQuarter, "Repeated invocation metadata reset the posture")
        nextTask.invocationID = "task-b"; view.update(nextTask)
        precondition(view.posture(for: nextTask, at: 11).kind == .standing, "A new task inherited the previous task's working pose")
        _ = view.posture(for: nextTask, at: 11.4)
        precondition(view.posture(for: nextTask, at: 12).kind == .workThreeQuarter)
        view.loadRigs(directory: directory)
        precondition(view.posture(for: nextTask, at: 12).kind == .standing, "Artwork reload retained a stale pose schedule")
        let clipsJSON = """
        {"work":{"selection":"activity","holdSeconds":[0.6,0.6],"turnSeconds":0.3,"settleSeconds":0.55},
         "dance":{"selection":"measured-beat","beatsPerPose":2,"transitionSeconds":0.22,"poses":["dance-1","dance-2","dance-3","dance-4"]},
         "walk":{"stepSeconds":0.65,"durationSeconds":2.6,"poses":["walk-left","walk-right"],"phases":["contact","passing"],"facing":"right"}}
        """
        var timed = choreography
        timed["clips"] = try JSONSerialization.jsonObject(with: Data(clipsJSON.utf8))
        timed["characters"] = ["code/work-three-quarter": authored, "code/work-profile": authored]
        try JSONSerialization.data(withJSONObject: timed).write(to: directory.appendingPathComponent("choreography.json"))
        view.loadRigs(directory: directory); view.snapshotTime = 0; view.replace([oldNarrator], animated: false)
        for time in [0.0, 0.4, 0.95, 1.0] { _ = view.posture(for: oldNarrator, at: time) }
        precondition(view.posture(for: oldNarrator, at: 1.6).kind == .workProfile,
                     "CharacterView ignored the authored work hold despite loading its pose library")
        // AppKit redraws/resizing must read a frame without changing the next scheduled posture.
        let repainted = CharacterView(frame: view.frame)
        view.loadRigs(directory: directory); repainted.loadRigs(directory: directory)
        view.snapshotTime = 0; repainted.snapshotTime = 0
        view.replace([oldNarrator], animated: false); repainted.replace([oldNarrator], animated: false)
        let repaintBuffer = repainted.bitmapImageRepForCachingDisplay(in: repainted.bounds)!
        for time in [1.3, 1.5, 2.0, 2.5] {
            repainted.snapshotTime = time
            repainted.cacheDisplay(in: repainted.bounds, to: repaintBuffer)
            _ = repainted.displayPosture(for: oldNarrator, at: time)
        }
        for time in [3.0, 3.3, 3.6] {
            view.snapshotTime = time; repainted.snapshotTime = time
            view.tick(); repainted.tick()
            let a = view.displayPosture(for: oldNarrator, at: time), b = repainted.displayPosture(for: oldNarrator, at: time)
            precondition(a.kind == b.kind && abs(a.scaleX - b.scaleX) < 0.000001 && abs(a.opacity - b.opacity) < 0.000001,
                         "Reading render frames advanced a character's posture schedule")
        }
        print("PASS lazy pose loading: zero startup decodes, one decode per selected rig, cached failures")
        for (role, armID) in [("devops", "tool-arm"), ("tester", "controller-arms")] {
            var value = definition("layer.png")
            let base = value["layers"] as! [[String: Any]]
            func joint(_ id: String) -> [String: Any] {
                ["id": id, "file": "layer.png", "parent": "body", "pivot": [80, 160], "motion": "arm", "amplitudeDegrees": 2]
            }
            value["layers"] = [base[0], joint(armID), joint("prop"), base[1]]
            let decoded = try JSONDecoder().decode(RigManifest.Character.self, from: JSONSerialization.data(withJSONObject: value))
            let rig = LayeredRig(definition: decoded, directory: directory)!
            var animation = WorkAnimation(seed: role); animation.update(active: true, at: 0)
            let raw = animation.pose(rig: role, at: 1000.123, reduced: false)
            let held = raw.forPose(rig: role, standing: false)
            let drawn = raw.forDrawnPose(rig: role)
            let driver = raw.joints[armID]!
            precondition(drawn.joints["arm-right"]!.angle == driver.angle && drawn.joints["arm-right"]!.y == driver.y,
                         "\(role) authored view lost its actual tool gesture")
            if role == "tester" {
                precondition(drawn.joints["arm-left"]!.angle == driver.angle, "Drawn controller hands lost their coupling")
            }
            let box = NSRect(x: 0, y: 0, width: 256, height: 384), point = NSPoint(x: 120, y: 220)
            func moved(_ layerID: String, _ work: WorkPose) -> NSPoint {
                let layer = rig.definition.layers.first { $0.id == layerID }!
                return rig.transform(for: layer, target: box, pose: LayerPose(), time: 0.75, gestureElapsed: nil,
                                     reduced: false, work: work.joints[layerID]).transform(point)
            }
            let baselineHand = moved(armID, raw), baselineProp = moved("prop", raw)
            precondition(hypot(baselineHand.x - baselineProp.x, baselineHand.y - baselineProp.y) > 0.01,
                         "Joint fixture did not reproduce the detached prop")
            let hand = moved(armID, held), prop = moved("prop", held)
            precondition(hypot(hand.x - prop.x, hand.y - prop.y) < 0.000001, "\(role) pose prop detached from its hand")
            precondition(raw.forPose(rig: role, standing: true).joints["prop"] == nil, "Standing rig gained an unwanted pose adapter")
            precondition(raw.forPose(rig: "code", standing: false).joints["prop"] == nil, "Another role inherited a specialist prop")
        }
        print("PASS specialist pose props track their original hand transforms; standing and other roles remain unchanged")
        // A layered character must remain visible when the old full-body atlas is absent.
        let coloured = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 256, pixelsHigh: 384,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0)!
        memset(coloured.bitmapData!, 0, coloured.bytesPerRow * coloured.pixelsHigh)
        let red = NSColor(deviceRed: 1, green: 0, blue: 0, alpha: 1)
        for y in 80..<350 { for x in 40..<220 { coloured.setColor(red, atX: x, y: y) } }
        try coloured.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("layer.png"))
        view.loadRigs(directory: directory); view.atlas = nil; view.snapshotTime = 1000
        precondition(view.hasArtwork, "Native host would hide a valid layered renderer")
        view.replace([Character(id: "layered-only", column: 1, label: "CODE", state: "idle", rig: "code")], animated: false)
        let capture = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
        view.cacheDisplay(in: view.bounds, to: capture)
        let center = capture.colorAt(x: capture.pixelsWide / 2, y: capture.pixelsHigh / 2)!.usingColorSpace(.deviceRGB)!
        precondition(center.redComponent > 0.45 && center.greenComponent < 0.2 && center.alphaComponent > 0.5,
                     "Layered rendering still depends on the legacy full-body atlas")
        print("PASS visible layered artwork without any legacy atlas")
    }
}
