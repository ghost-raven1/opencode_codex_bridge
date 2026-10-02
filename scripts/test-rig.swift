import AppKit

@main struct RigTests {
    static let frames = ["close", "slightly-open", "A", "O", "E", "I", "U", "smile-speaking",
                         "open", "quarter", "half", "three-quarter", "closed", "reopen", "smile", "concern", "focus", "surprise"]
    static func image(_ path: URL, width: Int = 256, height: Int = 384) throws {
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0)!
        bitmap.bitmapData!.initialize(repeating: 0, count: bitmap.bytesPerRow * height)
        bitmap.setColor(NSColor(deviceRed: 1, green: 0, blue: 0, alpha: 1), atX: width / 2, y: height / 2)
        try bitmap.representation(using: .png, properties: [:])!.write(to: path)
    }
    static func layer(_ id: String, _ parent: String?, _ motion: String, _ pivot: [Double], _ amplitude: Double) -> [String: Any] {
        ["id": id, "file": "layer.png", "parent": parent as Any? ?? NSNull(), "motion": motion,
         "pivot": pivot, "amplitudeDegrees": amplitude]
    }
    static func near(_ a: NSPoint, _ b: NSPoint) { precondition(hypot(a.x - b.x, a.y - b.y) < 0.0001, "Unexpected joint transform: \(a) vs \(b)") }
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("codexbridge-rig-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try image(directory.appendingPathComponent("layer.png"))
        try image(directory.appendingPathComponent("face.png"), height: 384 * 18)
        let layers = [layer("body", nil, "body", [128, 368], 0), layer("arm", "body", "arm", [80, 160], 3),
                      layer("hair", "head", "hair", [105, 90], 2), layer("head", "body", "head", [128, 120], 1.5)]
        var character: [String: Any] = ["layers": layers,
            "face": ["file": "face.png", "frameHeight": 384, "frames": frames],
            "motion": ["breathSeconds": 4.8, "gestureSeconds": 4.0, "gestureIntervalSeconds": [9.0, 13.0]]]
        func write(_ character: [String: Any], width: Int = 256) throws {
            let json: [String: Any] = ["version": 1, "canvas": ["width": width, "height": 384], "characters": ["test": character]]
            try JSONSerialization.data(withJSONObject: json).write(to: directory.appendingPathComponent("manifest.json"))
        }
        try write(character)
        let rig = LayeredRig.load(directory: directory)["test"]!
        precondition(rig.gestureInterval == 9...13)
        let target = NSRect(x: 10, y: 20, width: 128, height: 192)
        let pose = LayerPose(bodyScaleY: 1, headX: 2, headY: 4, headAngle: 0)
        let point = NSPoint(x: 50, y: 100)
        let definitions = rig.definition.layers
        let body = definitions.first(where: { $0.id == "body" })!, head = definitions.first(where: { $0.id == "head" })!
        let arm = definitions.first(where: { $0.id == "arm" })!, hair = definitions.first(where: { $0.id == "hair" })!
        func transform(_ layer: RigManifest.Layer, _ time: Double = 0, _ reduced: Bool = false, _ pose: LayerPose = pose) -> NSAffineTransform {
            rig.transform(for: layer, target: target, pose: pose, time: time, gestureElapsed: nil, reduced: reduced)
        }
        near(transform(body).transform(point), point)
        near(transform(arm).transform(point), point)
        near(transform(head).transform(point), NSPoint(x: point.x + 1, y: point.y + 2))
        near(transform(hair).transform(point), transform(head).transform(point))
        let hairOnly = transform(hair, 1, false, LayerPose()).transform(point)
        near(transform(hair, 1).transform(point), NSPoint(x: hairOnly.x + 1, y: hairOnly.y + 2))
        let pivot = NSPoint(x: 74, y: 152), limit = 1.5 * Double.pi / 180
        near(transform(head, 0, false, LayerPose(headAngle: 99)).transform(NSPoint(x: pivot.x + 10, y: pivot.y)),
             NSPoint(x: pivot.x + 10 * cos(limit), y: pivot.y + 10 * sin(limit)))
        for layer in definitions {
            for time in [0.0, 2.0, 30.0] { near(transform(layer, time, true, LayerPose(headX: 7, headY: 8, headAngle: 99)).transform(point), point) }
            near(rig.transform(for: layer, target: target, pose: pose, time: 1, gestureElapsed: 1, reduced: true,
                               beatArm: 99, beatHair: 99, work: WorkJoint(angle: 99, x: 99, y: 99)).transform(point), point)
        }
        let bounded = rig.transform(for: arm, target: target, pose: LayerPose(), time: 0, gestureElapsed: nil,
                                    reduced: false, beatArm: 999, work: WorkJoint(angle: 99, x: 99, y: -99))
        let armPivot = NSPoint(x: target.minX + 80 * target.width / 256, y: target.minY + (384 - 160) * target.height / 384)
        near(bounded.transform(armPivot), NSPoint(x: armPivot.x + 0.75, y: armPivot.y - 0.75))
        let angleLimit = 3.0 * Double.pi / 180
        near(bounded.transform(NSPoint(x: armPivot.x + 10, y: armPivot.y)),
             NSPoint(x: armPivot.x + 0.75 + cos(angleLimit) * 10, y: armPivot.y - 0.75 + sin(angleLimit) * 10))
        for layer in [arm, hair] {
            let positions = Set((0..<120).map { frame -> String in
                let moved = transform(layer, Double(frame) / 24).transform(point)
                return "\(moved.x),\(moved.y)"
            })
            precondition(positions.count > 60, "Independent layer has too few positions")
        }
        var ambient = AmbientMotion(now: 100, gestureInterval: rig.gestureInterval)
        precondition((109...113).contains(ambient.gestureAt))
        ambient.advance(114, gestureInterval: rig.gestureInterval)
        precondition(ambient.gestureStart == 114 && (123...127).contains(ambient.gestureAt))
        try write(character, width: 255); precondition(LayeredRig.load(directory: directory).isEmpty)
        try write(character)
        try image(directory.appendingPathComponent("face.png"), height: 384 * 17)
        precondition(LayeredRig.load(directory: directory).isEmpty, "Wrong face pixel height must fall back")
        try image(directory.appendingPathComponent("face.png"), height: 384 * 18)
        try image(directory.appendingPathComponent("layer.png"), width: 255)
        precondition(LayeredRig.load(directory: directory).isEmpty, "Wrong cutout size must fall back")
        try image(directory.appendingPathComponent("layer.png"))
        character["face"] = ["file": "face.png", "frameHeight": 384, "frames": Array(frames.prefix(17))]
        try write(character); precondition(LayeredRig.load(directory: directory).isEmpty)
        character["face"] = ["file": "face.png", "frameHeight": 384, "frames": frames]
        var reversed = frames; reversed.swapAt(0, 1)
        character["face"] = ["file": "face.png", "frameHeight": 384, "frames": reversed]
        try write(character); precondition(LayeredRig.load(directory: directory).isEmpty, "Frame order must match native facial indices")
        character["face"] = ["file": "face.png", "frameHeight": 384, "frames": frames]
        character["layers"] = layers + [layers[0]]
        try write(character); precondition(LayeredRig.load(directory: directory).isEmpty)
        character["layers"] = layers
        character["motion"] = ["breathSeconds": 4.8, "gestureSeconds": 3.6, "gestureIntervalSeconds": [15, 8]]
        try write(character); precondition(LayeredRig.load(directory: directory).isEmpty)
        precondition(LayeredRig.load(directory: directory.appendingPathComponent("missing")).isEmpty)
        let sprites = SpriteCache(), source = NSImage(contentsOf: directory.appendingPathComponent("layer.png"))!
        precondition(sprites.frame(source, column: 0, row: 0, rows: 0, radius: 1) == nil)
        precondition(sprites.frame(source, column: 0, row: 0, rows: 1, radius: 1, columns: 0) == nil)
        precondition(sprites.frame(source, column: -1, row: 0, rows: 1, radius: 1, columns: 1) == nil)
        precondition(sprites.frame(source, column: 0, row: 18, rows: 18, radius: 1, columns: 1) == nil)
        if CommandLine.arguments.count > 1 {
            let assets = URL(fileURLWithPath: CommandLine.arguments[1])
            let manifest = try JSONDecoder().decode(RigManifest.self, from: Data(contentsOf: assets.appendingPathComponent("manifest.json")))
            let loaded = LayeredRig.load(directory: assets)
            precondition(!loaded.isEmpty && Set(loaded.keys) == Set(manifest.characters.keys), "One or more shipped layered characters failed to load")
            print("PASS shipped layered rig dimensions and manifest: \(loaded.keys.sorted().joined(separator: ", "))")
        }
        print("PASS rig canvas/face dimensions, valid hierarchy, parent transforms, >60 arm/hair positions, reduced motion, joint limits, gesture timing and malformed/missing fallback")
    }
}
