import AppKit

/// Authored cutout layers share the base canvas and carry pivots in top-left source pixels.
struct RigManifest: Decodable {
    struct Canvas: Decodable { let width: Int; let height: Int }
    struct Layer: Decodable {
        let id: String; let file: String; let parent: String?; let pivot: [Double]
        let motion: String; let amplitudeDegrees: Double
    }
    struct Face: Decodable { let file: String; let frameHeight: Int; let frames: [String]; let neutralOnly: Bool? }
    struct Timing: Decodable {
        let breathSeconds: Double; let gestureSeconds: Double; let gestureIntervalSeconds: [Double]
        let translationLimit: Double?; let projectedJoints: Bool?
    }
    struct Character: Decodable { let layers: [Layer]; let face: Face; let motion: Timing }
    let version: Int; let canvas: Canvas; let characters: [String: Character]
}

/// Cache loaded layer art; only affine transforms change while a character is animated.
final class LayeredRig {
    static let faceFrames = ["close", "slightly-open", "A", "O", "E", "I", "U", "smile-speaking",
                             "open", "quarter", "half", "three-quarter", "closed", "reopen", "smile", "concern", "focus", "surprise"]
    let definition: RigManifest.Character
    private let layers: [(RigManifest.Layer, NSImage)]
    private let face: NSImage?
    private let head: RigManifest.Layer
    private let body: RigManifest.Layer
    private let bodyMask: CGImage
    private let shadows: [String: NSImage]
    var gestureInterval: ClosedRange<Double> { definition.motion.gestureIntervalSeconds[0]...definition.motion.gestureIntervalSeconds[1] }

    init?(definition: RigManifest.Character, directory: URL) {
        let interval = definition.motion.gestureIntervalSeconds
        let face = definition.face.neutralOnly == true ? nil : NSImage(contentsOf: directory.appendingPathComponent(definition.face.file))
        guard definition.face.frames == Self.faceFrames,
              definition.face.frameHeight == 384,
              definition.motion.breathSeconds.isFinite, definition.motion.breathSeconds > 0,
              definition.motion.gestureSeconds.isFinite, definition.motion.gestureSeconds > 0,
              definition.motion.translationLimit.map({ $0.isFinite && (0...1.5).contains($0) }) ?? true,
              interval.count == 2, interval.allSatisfy({ $0.isFinite && $0 > 0 }), interval[0] <= interval[1],
              definition.face.neutralOnly == true || face.map({ Self.hasPixels($0, width: 256, height: 384 * 18) }) == true,
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
        let bodyImage = loaded.first { $0.0.id == "body" }!.1
        var rect = NSRect(origin: .zero, size: bodyImage.size)
        guard let bodyMask = bodyImage.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return nil }
        self.shadows = Dictionary(uniqueKeysWithValues: loaded.compactMap { layer, image in
            guard ["head", "arm", "prop"].contains(layer.motion), let shadow = SpriteDepth.shadow(image) else { return nil }
            return (layer.id, shadow)
        })
        self.definition = definition; self.layers = loaded; self.face = face; self.head = head
        self.body = body; self.bodyMask = bodyMask
    }

    private static func hasPixels(_ image: NSImage, width: Int, height: Int) -> Bool {
        var rect = NSRect(origin: .zero, size: image.size)
        guard let pixels = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return false }
        return pixels.width == width && pixels.height == height
    }

    static func load(directory: URL, manifest name: String = "manifest.json") -> [String: LayeredRig] {
        definitions(directory: directory, manifest: name).compactMapValues { LayeredRig(definition: $0, directory: directory) }
    }

    static func definitions(directory: URL, manifest name: String) -> [String: RigManifest.Character] {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)),
              let manifest = try? JSONDecoder().decode(RigManifest.self, from: data),
              manifest.version == 1, manifest.canvas.width == 256, manifest.canvas.height == 384 else { return [:] }
        return manifest.characters
    }

    func draw(in target: NSRect, pose: LayerPose, time: Double, gestureElapsed: Double?, reduced: Bool,
              opacity: Double, radius: CGFloat, faceRows: [Int], sprites: SpriteCache,
              beatArm: Double = 0, beatHair: Double = 0, work: WorkPose = WorkPose(), headRig: LayeredRig? = nil,
              depth: DepthPose = DepthPose()) {
        let depth = reduced ? DepthPose() : depth
        let bodyLayers = headRig == nil ? layers : layers.filter { $0.0.motion != "head" && $0.0.parent != "head" }
        let mixedLayers = headRig?.layers.filter { $0.0.motion == "head" || $0.0.parent == "head" } ?? []
        // A transferred ponytail stays behind the chosen outfit and held objects.
        let back = mixedLayers.filter { $0.0.id == "hair-back" }.map { (headRig!, $0.0, $0.1) }
        let front = mixedLayers.filter { $0.0.id != "hair-back" }.map { (headRig!, $0.0, $0.1) }
        let entries = back + bodyLayers.map { (self, $0.0, $0.1) } + front
        NSGraphicsContext.saveGraphicsState()
        SpriteDepth.projection(pivot: body.pivot, target: target, turn: depth.turn).concat()
        for (source, layer, image) in entries {
            let destination = source === self ? target : alignedHeadTarget(from: source, target: target)
            let rendered = sprites.frame(image, column: 0, row: 0, rows: 1, radius: radius, columns: 1,
                face: layer.id == "head" ? source.face : nil, faceRows: layer.id == "head" && source.face != nil ? faceRows : [],
                light: depth.light(head: layer.motion == "head" || layer.parent == "head"))
            NSGraphicsContext.saveGraphicsState()
            source.transform(for: layer, target: destination, pose: pose, time: time, gestureElapsed: gestureElapsed,
                reduced: reduced, beatArm: beatArm, beatHair: beatHair, work: work.joints[layer.id], depth: depth).concat()
            rendered?.draw(in: destination, from: .zero, operation: .sourceOver, fraction: opacity)
            NSGraphicsContext.restoreGraphicsState()
            if layer.id == "body" {
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current?.cgContext.clip(to: target, mask: bodyMask)
                for (owner, caster, _) in entries {
                    guard let shadow = owner.shadows[caster.id] else { continue }
                    let destination = owner === self ? target : alignedHeadTarget(from: owner, target: target)
                    NSGraphicsContext.saveGraphicsState()
                    owner.transform(for: caster, target: destination, pose: pose, time: time, gestureElapsed: gestureElapsed,
                        reduced: reduced, beatArm: beatArm, beatHair: beatHair, work: work.joints[caster.id], depth: depth).concat()
                    shadow.draw(in: destination.offsetBy(dx: target.width * 3 / 256, dy: -target.height * 3 / 384),
                                from: .zero, operation: .sourceOver, fraction: opacity)
                    NSGraphicsContext.restoreGraphicsState()
                }
                NSGraphicsContext.restoreGraphicsState()
            }
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    /// Mixed identities share the outfit's neck, while keeping the other face and hair proportions.
    func alignedHeadTarget(from source: LayeredRig, target: NSRect) -> NSRect {
        target.offsetBy(dx: (head.pivot[0] - source.head.pivot[0]) * target.width / 256,
                        dy: (source.head.pivot[1] - head.pivot[1]) * target.height / 384)
    }

    /// A child first rotates around its own joint, then follows its parent's head transform.
    func transform(for layer: RigManifest.Layer, target: NSRect, pose: LayerPose, time: Double,
                   gestureElapsed: Double?, reduced: Bool, beatArm: Double = 0, beatHair: Double = 0,
                   work: WorkJoint? = nil, depth: DepthPose = DepthPose()) -> NSAffineTransform {
        var angle = Self.angle(layer: layer, time: time, gestureElapsed: gestureElapsed,
                               duration: definition.motion.gestureSeconds, reduced: reduced)
        if !reduced {
            let direction = layer.id.contains("left") || layer.id.contains("hip") ? -1.0 : 1.0
            let beat = layer.motion == "arm" ? beatArm * direction : layer.motion == "hair" ? beatHair : 0
            angle = min(layer.amplitudeDegrees, max(-layer.amplitudeDegrees, angle + beat * layer.amplitudeDegrees + (work?.angle ?? 0)))
        }
        let limit = CGFloat(definition.motion.translationLimit ?? 1.5)
        let x = reduced ? 0 : min(limit, max(-limit, work?.x ?? 0)), y = reduced ? 0 : min(limit, max(-limit, work?.y ?? 0))
        let transform = Self.affine(pivot: layer.pivot, target: target, angle: angle, x: x, y: y)
        if !reduced && (layer.motion == "head" || layer.parent == "head") {
            let angle = min(head.amplitudeDegrees, max(-head.amplitudeDegrees, pose.headAngle))
            let x = definition.motion.translationLimit.map { min(CGFloat($0), max(-CGFloat($0), pose.headX)) } ?? pose.headX
            let y = definition.motion.translationLimit.map { min(CGFloat($0), max(-CGFloat($0), pose.headY)) } ?? pose.headY
            transform.append(Self.affine(pivot: head.pivot, target: target, angle: angle, x: x, y: y) as AffineTransform)
            if definition.motion.projectedJoints != false {
                transform.append(SpriteDepth.projection(pivot: head.pivot, target: target, turn: depth.headTurn, foreground: true) as AffineTransform)
            }
        } else if !reduced && definition.motion.projectedJoints != false && ["arm", "prop"].contains(layer.motion) {
            let anchor = layer.motion == "arm" ? layer : definition.layers.filter { $0.motion == "arm" }.min {
                hypot($0.pivot[0] - layer.pivot[0], $0.pivot[1] - layer.pivot[1]) < hypot($1.pivot[0] - layer.pivot[0], $1.pivot[1] - layer.pivot[1])
            } ?? layer
            transform.append(SpriteDepth.projection(pivot: anchor.pivot, target: target, turn: depth.turn * 0.6, foreground: true) as AffineTransform)
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

/// Optional pose sheets decode only when selected; failed poses are also cached for safe fallback.
final class PoseRigLibrary {
    private let directory: URL
    private let definitions: [String: RigManifest.Character]
    private var loaded: [String: LayeredRig] = [:]
    private var failed = Set<String>()
    private(set) var loadCount = 0

    init(directory: URL) {
        self.directory = directory
        definitions = LayeredRig.definitions(directory: directory, manifest: "poses.json")
            .merging(LayeredRig.definitions(directory: directory, manifest: "choreography.json")) { _, authored in authored }
    }

    func contains(_ name: String) -> Bool { definitions[name] != nil && !failed.contains(name) }

    func rig(_ name: String) -> LayeredRig? {
        if let cached = loaded[name] { return cached }
        guard !failed.contains(name), let definition = definitions[name] else { return nil }
        loadCount += 1
        guard let rig = LayeredRig(definition: definition, directory: directory) else { failed.insert(name); return nil }
        loaded[name] = rig
        return rig
    }
}
