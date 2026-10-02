import AppKit

/// Authored cutout layers share the base canvas and carry pivots in top-left source pixels.
struct RigManifest: Decodable {
    struct Canvas: Decodable { let width: Int; let height: Int }
    struct Layer: Decodable {
        let id: String; let file: String; let parent: String?; let pivot: [Double]
        let motion: String; let amplitudeDegrees: Double
    }
    struct Face: Decodable { let file: String; let frameHeight: Int; let frames: [String] }
    struct Timing: Decodable { let breathSeconds: Double; let gestureSeconds: Double; let gestureIntervalSeconds: [Double] }
    struct Character: Decodable { let layers: [Layer]; let face: Face; let motion: Timing }
    let version: Int; let canvas: Canvas; let characters: [String: Character]
}

/// Cache loaded layer art; only affine transforms change while a character is animated.
final class LayeredRig {
    static let faceFrames = ["close", "slightly-open", "A", "O", "E", "I", "U", "smile-speaking",
                             "open", "quarter", "half", "three-quarter", "closed", "reopen", "smile", "concern", "focus", "surprise"]
    let definition: RigManifest.Character
    private let layers: [(RigManifest.Layer, NSImage)]
    private let face: NSImage
    private let head: RigManifest.Layer
    var gestureInterval: ClosedRange<Double> { definition.motion.gestureIntervalSeconds[0]...definition.motion.gestureIntervalSeconds[1] }

    init?(definition: RigManifest.Character, directory: URL) {
        let interval = definition.motion.gestureIntervalSeconds
        guard definition.face.frames == Self.faceFrames,
              definition.face.frameHeight == 384,
              definition.motion.breathSeconds.isFinite, definition.motion.breathSeconds > 0,
              definition.motion.gestureSeconds.isFinite, definition.motion.gestureSeconds > 0,
              interval.count == 2, interval.allSatisfy({ $0.isFinite && $0 > 0 }), interval[0] <= interval[1],
              let face = NSImage(contentsOf: directory.appendingPathComponent(definition.face.file)),
              Self.hasPixels(face, width: 256, height: 384 * 18),
              Set(definition.layers.map(\.id)).count == definition.layers.count,
              let body = definition.layers.first(where: { $0.id == "body" }), body.motion == "body", body.parent == nil,
              let head = definition.layers.first(where: { $0.id == "head" }), head.motion == "head", head.parent == "body" else { return nil }
        var loaded: [(RigManifest.Layer, NSImage)] = []
        for layer in definition.layers {
            guard layer.pivot.count == 2, layer.pivot.allSatisfy({ $0.isFinite }),
                  (0...256).contains(layer.pivot[0]), (0...384).contains(layer.pivot[1]),
                  layer.amplitudeDegrees.isFinite, layer.amplitudeDegrees >= 0,
                  ["body", "head", "arm", "hair", "prop"].contains(layer.motion),
                  layer.id == "body" || layer.parent == "body" || layer.parent == "head",
                  let image = NSImage(contentsOf: directory.appendingPathComponent(layer.file)),
                  Self.hasPixels(image, width: 256, height: 384) else { return nil }
            loaded.append((layer, image))
        }
        let occluders = loaded.filter { ["head", "arm"].contains($0.0.motion) }.map { $0.1 }
        loaded = loaded.map { layer, image in
            (layer, layer.id == "body" ? SpriteDepth.body(image, under: occluders) : image)
        }
        self.definition = definition; self.layers = loaded; self.face = face; self.head = head
    }

    private static func hasPixels(_ image: NSImage, width: Int, height: Int) -> Bool {
        var rect = NSRect(origin: .zero, size: image.size)
        guard let pixels = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return false }
        return pixels.width == width && pixels.height == height
    }

    static func load(directory: URL) -> [String: LayeredRig] {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("manifest.json")),
              let manifest = try? JSONDecoder().decode(RigManifest.self, from: data),
              manifest.version == 1, manifest.canvas.width == 256, manifest.canvas.height == 384 else { return [:] }
        return manifest.characters.compactMapValues { LayeredRig(definition: $0, directory: directory) }
    }

    func draw(in target: NSRect, pose: LayerPose, time: Double, gestureElapsed: Double?, reduced: Bool,
              opacity: Double, radius: CGFloat, faceRows: [Int], sprites: SpriteCache,
              beatArm: Double = 0, beatHair: Double = 0, work: WorkPose = WorkPose(), headRig: LayeredRig? = nil) {
        let bodyLayers = headRig == nil ? layers : layers.filter { $0.0.motion != "head" && $0.0.parent != "head" }
        let mixedLayers = headRig?.layers.filter { $0.0.motion == "head" || $0.0.parent == "head" } ?? []
        // A transferred ponytail stays behind the chosen outfit and held objects.
        let back = mixedLayers.filter { $0.0.id == "hair-back" }.map { (headRig!, $0.0, $0.1) }
        let front = mixedLayers.filter { $0.0.id != "hair-back" }.map { (headRig!, $0.0, $0.1) }
        let entries = back + bodyLayers.map { (self, $0.0, $0.1) } + front
        for (source, layer, image) in entries {
            let destination = source === self ? target : alignedHeadTarget(from: source, target: target)
            let rendered = sprites.frame(image, column: 0, row: 0, rows: 1, radius: radius, columns: 1,
                face: layer.id == "head" ? source.face : nil, faceRows: layer.id == "head" ? faceRows : [])
            NSGraphicsContext.saveGraphicsState()
            source.transform(for: layer, target: destination, pose: pose, time: time, gestureElapsed: gestureElapsed,
                reduced: reduced, beatArm: beatArm, beatHair: beatHair, work: work.joints[layer.id]).concat()
            rendered?.draw(in: destination, from: .zero, operation: .sourceOver, fraction: opacity)
            NSGraphicsContext.restoreGraphicsState()
        }
    }

    /// Mixed identities share the outfit's neck, while keeping the other face and hair proportions.
    func alignedHeadTarget(from source: LayeredRig, target: NSRect) -> NSRect {
        target.offsetBy(dx: (head.pivot[0] - source.head.pivot[0]) * target.width / 256,
                        dy: (source.head.pivot[1] - head.pivot[1]) * target.height / 384)
    }

    /// A child first rotates around its own joint, then follows its parent's head transform.
    func transform(for layer: RigManifest.Layer, target: NSRect, pose: LayerPose, time: Double,
                   gestureElapsed: Double?, reduced: Bool, beatArm: Double = 0, beatHair: Double = 0,
                   work: WorkJoint? = nil) -> NSAffineTransform {
        var angle = Self.angle(layer: layer, time: time, gestureElapsed: gestureElapsed,
                               duration: definition.motion.gestureSeconds, reduced: reduced)
        if !reduced {
            let direction = layer.id.contains("left") || layer.id.contains("hip") ? -1.0 : 1.0
            let beat = layer.motion == "arm" ? beatArm * direction : layer.motion == "hair" ? beatHair : 0
            angle = min(layer.amplitudeDegrees, max(-layer.amplitudeDegrees, angle + beat * layer.amplitudeDegrees + (work?.angle ?? 0)))
        }
        let x = reduced ? 0 : min(1.5, max(-1.5, work?.x ?? 0)), y = reduced ? 0 : min(1.5, max(-1.5, work?.y ?? 0))
        let transform = Self.affine(pivot: layer.pivot, target: target, angle: angle, x: x, y: y)
        if !reduced && (layer.motion == "head" || layer.parent == "head") {
            let angle = min(head.amplitudeDegrees, max(-head.amplitudeDegrees, pose.headAngle))
            transform.append(Self.affine(pivot: head.pivot, target: target, angle: angle, x: pose.headX, y: pose.headY) as AffineTransform)
        }
        return transform
    }

    /// Subtle sway plus an independent occasional gesture, bounded by the artist's joint limit.
    static func angle(layer: RigManifest.Layer, time: Double, gestureElapsed: Double?, duration: Double, reduced: Bool) -> CGFloat {
        guard !reduced else { return 0 }
        switch layer.motion {
        case "hair": return sin(time * 0.9) * layer.amplitudeDegrees
        case "arm":
            let rest = sin(time * 0.65) * 0.08
            let gesture = gestureElapsed.flatMap { $0 >= 0 && $0 < duration ? pow(sin($0 / duration * .pi), 2) : nil } ?? 0
            return min(1, max(-1, rest + gesture)) * layer.amplitudeDegrees
        default: return 0
        }
    }

    private static func affine(pivot: [Double], target: NSRect, angle: CGFloat, x: CGFloat = 0, y: CGFloat = 0) -> NSAffineTransform {
        let point = NSPoint(x: target.minX + pivot[0] * target.width / 256,
                           y: target.minY + (384 - pivot[1]) * target.height / 384)
        let transform = NSAffineTransform()
        transform.translateX(by: point.x + x * target.width / 256, yBy: point.y + y * target.height / 384)
        transform.rotate(byDegrees: angle)
        transform.translateX(by: -point.x, yBy: -point.y)
        return transform
    }
}
