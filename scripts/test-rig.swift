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
    /// Moving a hand moves its shadow; lighting cannot paint outside the receiver silhouette.
    static func movingShadow(_ directory: URL) throws {
        func patch(_ file: String, rect: NSRect?, color: NSColor, rows: Int = 1) throws {
            let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 256, pixelsHigh: 384 * rows,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                bytesPerRow: 0, bitsPerPixel: 0)!
            bitmap.bitmapData!.initialize(repeating: 0, count: bitmap.bytesPerRow * bitmap.pixelsHigh)
            if let rect { for y in Int(rect.minY)..<Int(rect.maxY) { for x in Int(rect.minX)..<Int(rect.maxX) { bitmap.setColor(color, atX: x, y: y) } } }
            try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent(file))
        }
        try patch("receiver.png", rect: NSRect(x: 40, y: 80, width: 170, height: 250), color: NSColor(deviceRed: 0.78, green: 0.78, blue: 0.78, alpha: 1))
        try patch("caster.png", rect: NSRect(x: 90, y: 160, width: 26, height: 30), color: NSColor(deviceRed: 1, green: 0, blue: 0, alpha: 1))
        try patch("empty.png", rect: nil, color: .clear)
        try patch("empty-face.png", rect: nil, color: .clear, rows: 18)
        var body = layer("body", nil, "body", [128, 368], 0); body["file"] = "receiver.png"
        var head = layer("head", "body", "head", [128, 120], 0); head["file"] = "empty.png"
        var arm = layer("arm", "body", "arm", [100, 150], 3); arm["file"] = "caster.png"
        let value: [String: Any] = ["layers": [body, arm, head],
            "face": ["file": "empty-face.png", "frameHeight": 384, "frames": frames],
            "motion": ["breathSeconds": 4.8, "gestureSeconds": 3.6, "gestureIntervalSeconds": [8, 15]]]
        let definition = try JSONDecoder().decode(RigManifest.Character.self, from: JSONSerialization.data(withJSONObject: value))
        let rig = LayeredRig(definition: definition, directory: directory)!, cache = SpriteCache()
        func render(_ x: Double) -> NSBitmapImageRep {
            let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 256, pixelsHigh: 384,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                bytesPerRow: 0, bitsPerPixel: 0)!
            bitmap.bitmapData!.initialize(repeating: 0, count: bitmap.bytesPerRow * 384)
            NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
            rig.draw(in: NSRect(x: 0, y: 0, width: 256, height: 384), pose: LayerPose(), time: 0,
                gestureElapsed: nil, reduced: false, opacity: 1, radius: 1, faceRows: [], sprites: cache,
                work: WorkPose(joints: ["arm": WorkJoint(x: x)]))
            NSGraphicsContext.restoreGraphicsState(); return bitmap
        }
        let left = render(-1.5), right = render(1.5)
        var moved = 0
        for y in 0..<384 { for x in 0..<256 {
            let a = left.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!, b = right.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
            if x < 40 || x >= 210 || y < 80 || y >= 330 {
                precondition(abs(a.alphaComponent - b.alphaComponent) < 0.0001, "Cast shadow leaked outside the body")
            }
            if abs(a.redComponent - a.greenComponent) < 0.001, abs(b.redComponent - b.greenComponent) < 0.001,
               abs(a.redComponent - b.redComponent) > 0.012 { moved += 1 }
        } }
        precondition(moved > 8, "The hand moved but its shadow remained painted on the body")
    }
    /// A transferred ponytail must remain behind the selected outfit at their overlap.
    static func mixedHairOrder(_ directory: URL) throws {
        func patch(_ file: String, _ rect: NSRect, _ color: NSColor) throws {
            let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 256, pixelsHigh: 384,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                bytesPerRow: 0, bitsPerPixel: 0)!
            bitmap.bitmapData!.initialize(repeating: 0, count: bitmap.bytesPerRow * 384)
            for y in Int(rect.minY)..<Int(rect.maxY) { for x in Int(rect.minX)..<Int(rect.maxX) { bitmap.setColor(color, atX: x, y: y) } }
            try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent(file))
        }
        try patch("outfit.png", NSRect(x: 90, y: 170, width: 80, height: 44), NSColor(deviceRed: 0, green: 0, blue: 1, alpha: 1))
        try patch("ponytail.png", NSRect(x: 100, y: 175, width: 60, height: 30), NSColor(deviceRed: 1, green: 0, blue: 0, alpha: 1))
        try patch("portrait.png", NSRect(x: 180, y: 40, width: 20, height: 40), NSColor(deviceRed: 0, green: 1, blue: 0, alpha: 1))
        func definition(hair: Bool) throws -> RigManifest.Character {
            var body = layer("body", nil, "body", [128, 368], 0); body["file"] = "outfit.png"
            var head = layer("head", "body", "head", [128, 120], 0); head["file"] = "portrait.png"
            var tail = layer("hair-back", "head", "hair", [128, 120], 2); tail["file"] = "ponytail.png"
            let value: [String: Any] = ["layers": (hair ? [tail] : []) + [body, head],
                "face": ["file": "face.png", "frameHeight": 384, "frames": frames],
                "motion": ["breathSeconds": 4.8, "gestureSeconds": 3.6, "gestureIntervalSeconds": [8, 15]]]
            return try JSONDecoder().decode(RigManifest.Character.self, from: JSONSerialization.data(withJSONObject: value))
        }
        let outfit = LayeredRig(definition: try definition(hair: false), directory: directory)!
        let portrait = LayeredRig(definition: try definition(hair: true), directory: directory)!
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 256, pixelsHigh: 384,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        outfit.draw(in: NSRect(x: 0, y: 0, width: 256, height: 384), pose: LayerPose(), time: 0,
            gestureElapsed: nil, reduced: true, opacity: 1, radius: 0, faceRows: [], sprites: SpriteCache(), headRig: portrait)
        NSGraphicsContext.restoreGraphicsState()
        let pixel = bitmap.colorAt(x: 128, y: 192)!.usingColorSpace(.deviceRGB)!
        precondition(pixel.blueComponent > 0.95 && pixel.redComponent < 0.05, "Mixed back hair covered the outfit or prop: \(pixel)")
    }
    static func main() throws {
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("codexbridge-rig-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try image(directory.appendingPathComponent("layer.png"))
        try image(directory.appendingPathComponent("face.png"), height: 384 * 18)
        try mixedHairOrder(directory)
        try movingShadow(directory)
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
        var movedHead = character
        movedHead["layers"] = [layers[0], layer("head", "body", "head", [110, 83], 1.5)]
        try write(movedHead)
        let other = LayeredRig.load(directory: directory)["test"]!
        for scale in [0.5, 1.0, 2.0] {
            let box = NSRect(x: 10, y: 20, width: 256 * scale, height: 384 * scale)
            let aligned = rig.alignedHeadTarget(from: other, target: box)
            near(NSPoint(x: aligned.minX + 110 * scale, y: aligned.minY + (384 - 83) * scale),
                 NSPoint(x: box.minX + 128 * scale, y: box.minY + (384 - 120) * scale))
            precondition(aligned.size == box.size, "Mixing faces distorted the new head proportions")
        }
        try write(character)
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
        // Drawn views keep narrow cutout seams and skip unused neutral facial atlases.
        var authored = character
        authored["face"] = ["file": "intentionally-unused.png", "frameHeight": 384, "frames": frames, "neutralOnly": true]
        authored["motion"] = ["breathSeconds": 4.8, "gestureSeconds": 4.0, "gestureIntervalSeconds": [9, 13],
                              "translationLimit": 0.75, "projectedJoints": false]
        try write(authored)
        let cutout = LayeredRig.load(directory: directory)["test"]!
        let quietHead = cutout.transform(for: head, target: target, pose: LayerPose(headX: 99, headY: -99),
            time: 0, gestureElapsed: nil, reduced: false, depth: DepthPose(turn: 0.7, headTurn: 0.7))
        near(quietHead.transform(point), NSPoint(x: point.x + 0.375, y: point.y - 0.375))
        let quietArm = cutout.transform(for: arm, target: target, pose: LayerPose(), time: 0, gestureElapsed: nil,
            reduced: false, work: WorkJoint(x: 99, y: -99), depth: DepthPose(turn: 0.7))
        near(quietArm.transform(point), NSPoint(x: point.x + 0.375, y: point.y - 0.375))
        authored["motion"] = ["breathSeconds": 4.8, "gestureSeconds": 4.0, "gestureIntervalSeconds": [9, 13], "translationLimit": -1]
        try write(authored); precondition(LayeredRig.load(directory: directory).isEmpty)
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
