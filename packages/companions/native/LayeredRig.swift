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
    struct Character: Decodable {
        let layers: [Layer]; let face: Face; let motion: Timing; let skeleton: SkeletonDefinition?
        var renderScale: Double? = nil
        var renderHeadScale: Double? = nil
        var renderFeet: Double? = nil
    }
    let version: Int; let canvas: Canvas; let characters: [String: Character]
    let coordinates: String?; let feetBaseline: Int?; let clips: ChoreographyClips?

    static func read(directory: URL, name: String) -> RigManifest? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)),
              let manifest = try? JSONDecoder().decode(Self.self, from: data),
              manifest.version == 1, manifest.canvas.width == SpriteGeometry.width,
              manifest.canvas.height == SpriteGeometry.height,
              manifest.coordinates == nil || manifest.coordinates == "top-left",
              manifest.feetBaseline == nil || manifest.feetBaseline == SpriteGeometry.feetBaseline,
              manifest.clips?.isValid != false else { return nil }
        return manifest
    }
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
    private let shadows: [String: NSImage]
    let skeleton: SkeletalRig?
    var renderScale: CGFloat { CGFloat(definition.renderScale ?? 1) }
    var gestureInterval: ClosedRange<Double> { definition.motion.gestureIntervalSeconds[0]...definition.motion.gestureIntervalSeconds[1] }

    init?(definition: RigManifest.Character, directory: URL) {
        let interval = definition.motion.gestureIntervalSeconds
        guard definition.face.frames == Self.faceFrames,
              definition.face.frameHeight == SpriteGeometry.height,
              SpriteGeometry.isAssetPath(definition.face.file),
              definition.motion.breathSeconds.isFinite, definition.motion.breathSeconds > 0,
              definition.motion.gestureSeconds.isFinite, definition.motion.gestureSeconds > 0,
              definition.motion.translationLimit.map({ $0.isFinite && (0...1.5).contains($0) }) ?? true,
              definition.renderScale.map({ $0.isFinite && (0.5...2).contains($0) }) ?? true,
              definition.renderHeadScale.map({ $0.isFinite && (0.5...2).contains($0) }) ?? true,
              definition.renderFeet.map({ $0.isFinite && (0...384).contains($0) }) ?? true,
              interval.count == 2, interval.allSatisfy({ $0.isFinite && $0 > 0 }), interval[0] <= interval[1],
              Set(definition.layers.map(\.id)).count == definition.layers.count,
              let body = definition.layers.first(where: { $0.id == "body" }), body.motion == "body", body.parent == nil,
              let head = definition.layers.first(where: { $0.id == "head" }), head.motion == "head", head.parent == "body" else { return nil }
        let face = definition.face.neutralOnly == true ? nil : NSImage(contentsOf: directory.appendingPathComponent(definition.face.file))
        guard definition.face.neutralOnly == true || face.map({ Self.hasPixels($0, width: SpriteGeometry.width,
            height: SpriteGeometry.height * SpriteGeometry.faceRows) }) == true else { return nil }
        var loaded: [(RigManifest.Layer, NSImage)] = []
        for layer in definition.layers {
            guard layer.pivot.count == 2, layer.pivot.allSatisfy({ $0.isFinite }),
                  (0...Double(SpriteGeometry.width)).contains(layer.pivot[0]),
                  (0...Double(SpriteGeometry.height)).contains(layer.pivot[1]),
                  layer.amplitudeDegrees.isFinite, layer.amplitudeDegrees >= 0,
                  ["body", "head", "arm", "hair", "prop"].contains(layer.motion),
                  layer.id == "body" || layer.parent == "body" || layer.parent == "head",
                  SpriteGeometry.isAssetPath(layer.file),
                  let image = NSImage(contentsOf: directory.appendingPathComponent(layer.file)),
                  Self.hasPixels(image, width: SpriteGeometry.width, height: SpriteGeometry.height) else { return nil }
            loaded.append((layer, image))
        }
        // Keep the tail connected both to the resized crown and to the clothing's hidden socket.
        loaded = loaded.map { layer, image in
            (layer, layer.id == "hair-back" ? Self.registeredHair(image,
                scale: definition.renderHeadScale ?? 1, pivot: head.pivot) : image)
        }
        let skeleton = definition.skeleton.flatMap { SkeletalRig(definition: $0, layers: loaded) }
        guard definition.skeleton == nil || skeleton != nil else { return nil }
        self.skeleton = skeleton
        self.shadows = Dictionary(uniqueKeysWithValues: loaded.compactMap { layer, image in
            guard ["head", "arm", "prop"].contains(layer.motion), let shadow = SpriteDepth.shadow(image) else { return nil }
            return (layer.id, shadow)
        })
        self.definition = definition; self.layers = loaded; self.face = face; self.head = head
        self.body = body
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
        let skeletons = SkeletonManifest.read(directory: directory)
        return Dictionary(uniqueKeysWithValues: (RigManifest.read(directory: directory, name: name)?.characters ?? [:]).map { key, value in
            (key, RigManifest.Character(layers: value.layers, face: value.face, motion: value.motion,
                skeleton: skeletons[key] ?? value.skeleton, renderScale: value.renderScale,
                renderHeadScale: value.renderHeadScale, renderFeet: value.renderFeet))
        })
    }

    func draw(in target: NSRect, pose: LayerPose, time: Double, gestureElapsed: Double?, reduced: Bool,
              opacity: Double, radius: CGFloat, faceRows: [Int], sprites: SpriteCache,
              beatArm: Double = 0, beatHair: Double = 0, work: WorkPose = WorkPose(), headRig: LayeredRig? = nil,
              depth: DepthPose = DepthPose(), boneOffsets: [String: BoneOffset]? = nil,
              compositing: CGBlendMode = .normal) {
        let depth = reduced ? DepthPose() : depth
        let matrices = skeleton?.transforms(reduced ? [:] : boneOffsets ?? [:])
        let bodyLayers = headRig == nil ? layers : layers.filter { $0.0.motion != "head" && $0.0.parent != "head" }
        let mixedLayers = headRig?.layers.filter { $0.0.motion == "head" || $0.0.parent == "head" } ?? []
        // A transferred ponytail stays behind the chosen outfit and held objects.
        let back = mixedLayers.filter { $0.0.id == "hair-back" }.map { (headRig!, $0.0, $0.1) }
        let front = mixedLayers.filter { $0.0.id != "hair-back" }.map { (headRig!, $0.0, $0.1) }
        let entries = back + bodyLayers.map { (self, $0.0, $0.1) } + front
        NSGraphicsContext.saveGraphicsState()
        let context = NSGraphicsContext.current?.cgContext
        // Joint underlays and portrait patches form one puppet; fading them separately darkens every overlap.
        context?.setBlendMode(compositing); context?.setAlpha(opacity)
        context?.beginTransparencyLayer(in: target.insetBy(dx: -target.width * 0.25, dy: -target.height * 0.25), auxiliaryInfo: nil)
        SpriteDepth.projection(pivot: body.pivot, target: target, turn: depth.turn).concat()
        for (source, layer, image) in entries {
            let bodyLayer = layer.id == "body"
            if bodyLayer {
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current?.cgContext.setBlendMode(.normal)
                NSGraphicsContext.current?.cgContext.setAlpha(1)
                NSGraphicsContext.current?.cgContext.beginTransparencyLayer(
                    in: target.insetBy(dx: -target.width * 0.25, dy: -target.height * 0.25), auxiliaryInfo: nil)
            }
            let fraction = 1.0
            let destination = layer.motion == "head" || layer.parent == "head" ? alignedHeadTarget(from: source, target: target) : target
            let rendered = sprites.frame(image, column: 0, row: 0, rows: 1, radius: radius, columns: 1,
                face: layer.id == "head" ? source.face : nil, faceRows: layer.id == "head" && source.face != nil ? faceRows : [],
                light: depth.light(head: layer.motion == "head" || layer.parent == "head"))
            NSGraphicsContext.saveGraphicsState()
            if let rendered, let skeleton, let matrices {
                if layer.motion == "head" || layer.parent == "head" {
                    // A mixed portrait follows the outfit's neck/head bones and keeps its own hair pivot.
                    let local = source.transform(for: layer, target: destination, pose: LayerPose(), time: time,
                        gestureElapsed: nil, reduced: reduced, beatHair: beatHair, depth: depth)
                    skeleton.drawRigid(rendered, in: destination, bone: "head", reference: target,
                        transforms: matrices, opacity: fraction, local: local)
                } else { skeleton.draw(rendered, layer: layer.id, in: destination, transforms: matrices, opacity: fraction) }
            } else {
                source.transform(for: layer, target: destination, pose: pose, time: time, gestureElapsed: gestureElapsed,
                    reduced: reduced, beatArm: beatArm, beatHair: beatHair, work: work.joints[layer.id], depth: depth).concat()
                rendered?.draw(in: destination, from: .zero, operation: .sourceOver, fraction: fraction)
            }
            NSGraphicsContext.restoreGraphicsState()
            if bodyLayer {
                for (owner, caster, _) in entries {
                    guard let shadow = owner.shadows[caster.id] else { continue }
                    let destination = caster.motion == "head" || caster.parent == "head" ? alignedHeadTarget(from: owner, target: target) : target
                    NSGraphicsContext.saveGraphicsState()
                    let shadowTarget = destination.offsetBy(dx: target.width * 3 / SpriteGeometry.size.width,
                                                            dy: -target.height * 3 / SpriteGeometry.size.height)
                    if let skeleton, let matrices {
                        if caster.motion == "head" || caster.parent == "head" {
                            let local = owner.transform(for: caster, target: destination, pose: LayerPose(), time: time,
                                gestureElapsed: nil, reduced: reduced, depth: depth)
                            skeleton.drawRigid(shadow, in: shadowTarget, bone: "head", reference: target,
                                transforms: matrices, opacity: 1, local: local, operation: .sourceAtop)
                        } else { skeleton.draw(shadow, layer: caster.id, in: shadowTarget,
                            transforms: matrices, opacity: 1, operation: .sourceAtop) }
                    } else {
                        owner.transform(for: caster, target: destination, pose: pose, time: time, gestureElapsed: gestureElapsed,
                            reduced: reduced, beatArm: beatArm, beatHair: beatHair, work: work.joints[caster.id], depth: depth).concat()
                        shadow.draw(in: shadowTarget, from: .zero, operation: .sourceAtop, fraction: 1)
                    }
                    NSGraphicsContext.restoreGraphicsState()
                }
                NSGraphicsContext.current?.cgContext.endTransparencyLayer()
                NSGraphicsContext.restoreGraphicsState()
            }
        }
        context?.endTransparencyLayer()
        NSGraphicsContext.restoreGraphicsState()
    }

    /// Uniform pose registration keeps the authored proportions and the same screen ground.
    func registeredTarget(_ target: NSRect) -> NSRect {
        let ground = target.minY + (384 - CGFloat(SpriteGeometry.feetBaseline)) * target.height / 384
        let width = target.width * renderScale, height = target.height * renderScale
        return NSRect(x: target.midX - width / 2,
            y: ground - (384 - CGFloat(definition.renderFeet ?? Double(SpriteGeometry.feetBaseline))) * height / 384,
            width: width, height: height)
    }

    /// Mixed identities share the outfit's neck, while keeping the other face and hair proportions.
    func alignedHeadTarget(from source: LayeredRig, target: NSRect) -> NSRect {
        let scale = source.renderScale * CGFloat(source.definition.renderHeadScale ?? 1) / renderScale
        let width = target.width * scale, height = target.height * scale
        return NSRect(x: target.minX + head.pivot[0] * target.width / 256 - source.head.pivot[0] * width / 256,
            y: target.minY + (384 - head.pivot[1]) * target.height / 384 - (384 - source.head.pivot[1]) * height / 384,
            width: width, height: height)
    }

    /// Prepare this attachment once: the crown scales with the head, the lower tail with the outfit.
    private static func registeredHair(_ image: NSImage, scale: Double, pivot: [Double]) -> NSImage {
        guard abs(scale - 1) > 1e-6 else { return image }
        var rect = NSRect(origin: .zero, size: image.size)
        guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return image }
        let source = NSBitmapImageRep(cgImage: cg)
        guard source.bitsPerSample == 8, source.samplesPerPixel == 4, !source.isPlanar,
              let input = source.bitmapData,
              let output = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 256, pixelsHigh: 384,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                bitmapFormat: source.bitmapFormat, bytesPerRow: 0, bitsPerPixel: 0),
              let bytes = output.bitmapData else { return image }
        bytes.initialize(repeating: 0, count: output.bytesPerRow * output.pixelsHigh)
        func attachmentScale(_ y: Double) -> Double {
            let t = min(1, max(0, (pivot[1] - y) / 48))
            return 1 + (scale - 1) * t * t * (3 - 2 * t)
        }
        for y in 0..<384 {
            let worldY = pivot[1] + (Double(y) + 0.5 - pivot[1]) * scale
            // This smooth mapping is monotone for the validated portrait scale range.
            var low = -384.0, high = 768.0
            for _ in 0..<24 {
                let middle = (low + high) / 2
                let mapped = pivot[1] + (middle - pivot[1]) * attachmentScale(middle)
                if mapped < worldY { low = middle } else { high = middle }
            }
            let sy = (low + high) / 2, localScale = attachmentScale(sy)
            for x in 0..<256 {
                let worldX = pivot[0] + (Double(x) + 0.5 - pivot[0]) * scale
                let sx = pivot[0] + (worldX - pivot[0]) / localScale
                let px = sx - 0.5, py = sy - 0.5, x0 = Int(floor(px)), y0 = Int(floor(py))
                let fx = px - Double(x0), fy = py - Double(y0)
                for channel in 0..<4 {
                    var value = 0.0
                    for (dx, wx) in [(0, 1 - fx), (1, fx)] { for (dy, wy) in [(0, 1 - fy), (1, fy)] {
                        let xx = x0 + dx, yy = y0 + dy
                        if (0..<256).contains(xx), (0..<384).contains(yy) {
                            value += Double(input[yy * source.bytesPerRow + xx * 4 + channel]) * wx * wy
                        }
                    } }
                    bytes[y * output.bytesPerRow + x * 4 + channel] = UInt8(min(255, max(0, value.rounded())))
                }
            }
        }
        let prepared = NSImage(size: image.size); prepared.addRepresentation(output); return prepared
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
        let point = NSPoint(x: target.minX + pivot[0] * target.width / SpriteGeometry.size.width,
                           y: target.minY + (Double(SpriteGeometry.height) - pivot[1]) * target.height / SpriteGeometry.size.height)
        let transform = NSAffineTransform()
        transform.translateX(by: point.x + x * target.width / SpriteGeometry.size.width,
                             yBy: point.y + y * target.height / SpriteGeometry.size.height)
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
    let clips: ChoreographyClips

    init(directory: URL) {
        self.directory = directory
        let choreography = RigManifest.read(directory: directory, name: "choreography.json")
        clips = choreography?.clips ?? .standard
        definitions = LayeredRig.definitions(directory: directory, manifest: "poses.json")
            .merging(choreography == nil ? [:] : LayeredRig.definitions(directory: directory, manifest: "choreography.json")) { _, authored in authored }
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
