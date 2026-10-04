import AppKit

private final class SurfaceView: NSView {
    let paint: () -> Void
    init(frame: NSRect, paint: @escaping () -> Void) { self.paint = paint; super.init(frame: frame) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func draw(_ dirtyRect: NSRect) { paint() }
}

/// A deforming solid panel must stay solid: translation alone does not exercise triangle clipping.
@main struct SkinSurfaceTests {
    static func check(_ condition: Bool, _ message: String) {
        if !condition { FileHandle.standardError.write(Data("FAIL skin-surface: \(message)\n".utf8)); exit(1) }
    }
    static func pixels(size: Int, draw: () -> Void) -> NSBitmapImageRep {
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 256 * size, pixelsHigh: 384 * size,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0)!
        bitmap.bitmapData!.initialize(repeating: 0, count: bitmap.bytesPerRow * bitmap.pixelsHigh)
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        NSGraphicsContext.current?.imageInterpolation = .none
        NSGraphicsContext.current?.cgContext.scaleBy(x: CGFloat(size), y: CGFloat(size))
        draw(); NSGraphicsContext.restoreGraphicsState()
        return bitmap
    }

    static func alphaBounds(_ image: NSImage) -> NSRect {
        var rect = NSRect(origin: .zero, size: image.size)
        let pixels = NSBitmapImageRep(cgImage: image.cgImage(forProposedRect: &rect, context: nil, hints: nil)!)
        var minX = pixels.pixelsWide, minY = pixels.pixelsHigh, maxX = 0, maxY = 0
        let alpha = pixels.bitmapFormat.contains(.alphaFirst) ? 0 : pixels.samplesPerPixel - 1
        for y in 0..<pixels.pixelsHigh { for x in 0..<pixels.pixelsWide {
            let opaque: Bool
            if pixels.bitsPerSample == 8, let bytes = pixels.bitmapData {
                opaque = bytes[y * pixels.bytesPerRow + x * pixels.samplesPerPixel + alpha] > 160
            } else { opaque = (pixels.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 160.0 / 255 }
            if opaque { minX = min(minX, x); minY = min(minY, y); maxX = max(maxX, x + 1); maxY = max(maxY, y + 1) }
        } }
        return maxX > minX ? NSRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY) : .zero
    }

    static func registration(_ directory: URL) {
        let manifests = ["manifest.json", "poses.json", "choreography.json"].flatMap {
            LayeredRig.definitions(directory: directory, manifest: $0)
        }
        let upright = Set(["work-three-quarter", "work-profile", "work-back-three-quarter", "work-back",
                           "work-right-three-quarter", "work-right-profile", "walk-left", "walk-right"])
        let target = NSRect(x: 10, y: 40, width: 256, height: 384)
        var references: [String: (head: Double, stature: Double)] = [:], checked = 0
        for (key, definition) in manifests.sorted(by: { $0.key.count < $1.key.count }) {
            guard let rig = LayeredRig(definition: definition, directory: directory) else { preconditionFailure("Invalid registered pose: \(key)") }
            let head = definition.layers.first { $0.id == "head" }!
            let headBox = alphaBounds(NSImage(contentsOf: directory.appendingPathComponent(head.file))!)
            let feet = definition.layers.filter { $0.motion != "prop" }.map {
                alphaBounds(NSImage(contentsOf: directory.appendingPathComponent($0.file))!).maxY
            }.max()!
            let role = String(key.split(separator: "/")[0])
            if let skeleton = rig.skeleton {
                let offsets = SkeletalMotion.offsets(rig: skeleton, role: role,
                    posture: key.split(separator: "/").dropFirst().first.map(String.init) ?? "standing", time: 1, seed: 7,
                    head: LayerPose(headX: 1, headY: 1, headAngle: 0.5), work: WorkPose(), music: MusicPose(),
                    beat: nil, speaking: false, reduced: false)
                let transforms = skeleton.transforms(offsets), point = skeleton.bones["head"]!.point
                let headJoint = transforms["head"]!.point(point), neckJoint = transforms["neck"]!.point(point)
                precondition(hypot(headJoint.x - neckJoint.x, headJoint.y - neckJoint.y) < 1e-6, "Moving head detached its socket: \(key)")
            }
            let destination = rig.registeredTarget(target), portrait = rig.alignedHeadTarget(from: rig, target: destination)
            if key == "code/work-profile" {
                let canvas = rig.registeredTarget(NSRect(origin: .zero, size: SpriteGeometry.size))
                let socket = pixels(size: 2) {
                    rig.draw(in: canvas, pose: LayerPose(), time: 0, gestureElapsed: nil, reduced: true,
                        opacity: 1, radius: 0, faceRows: [], sprites: SpriteCache())
                }
                for y in [106.0, 109, 112] { for x in [144.0, 145, 146] {
                    let px = Int((canvas.minX + x * canvas.width / 256) * 2)
                    let py = Int((384 - canvas.minY - (384 - y) * canvas.height / 384) * 2)
                    precondition(socket.colorAt(x: px, y: py)!.alphaComponent > 0.95,
                        "Portrait registration exposed the long-hair clothing socket")
                } }
            }
            let portraitHeight = headBox.height * portrait.height / 384
            let ground = destination.minY + (384 - feet) * destination.height / 384
            let crown = portrait.minY + (384 - headBox.minY) * portrait.height / 384
            precondition(abs(ground - 56) < 0.001, "Pose moved its ground: \(key)")
            if !key.contains("/") { references[role] = (portraitHeight, crown - ground) }
            let reference = references[role]!
            precondition(abs(portraitHeight - reference.head) < 0.001, "Portrait size changed in \(key)")
            precondition(crown - ground <= reference.stature + 0.001, "A bent pose grew taller: \(key)")
            if let pose = key.split(separator: "/").dropFirst().first, upright.contains(String(pose)) {
                precondition(abs(crown - ground - reference.stature) < 0.001, "Standing work/walk view changed stature: \(key)")
            }
            // A different head still meets the outfit's neck after separate size registration.
            if key.contains("/"), let base = manifests.first(where: { $0.key == "code" })?.value,
               let other = LayeredRig(definition: base, directory: directory) {
                let otherHead = base.layers.first { $0.id == "head" }!, aligned = rig.alignedHeadTarget(from: other, target: destination)
                let ownNeck = CGPoint(x: destination.minX + head.pivot[0] * destination.width / 256,
                    y: destination.minY + (384 - head.pivot[1]) * destination.height / 384)
                let otherNeck = CGPoint(x: aligned.minX + otherHead.pivot[0] * aligned.width / 256,
                    y: aligned.minY + (384 - otherHead.pivot[1]) * aligned.height / 384)
                precondition(hypot(ownNeck.x - otherNeck.x, ownNeck.y - otherNeck.y) < 1e-6, "Mixed neck detached: \(key)")
            }
            checked += 1
        }
        precondition(checked == 133)
        print("PASS 133 registered poses: fixed portrait size, fixed upright stature, natural lower bent poses, common ground and aligned mixed necks")
    }

    /// Fading a connected puppet must fade the whole picture once, including overlapping joint underlays.
    static func jointOpacity(_ base: RigManifest.Character) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("joint-opacity-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        for layer in base.layers {
            let image = pixels(size: 1) {
                if ["body", "head"].contains(layer.id) {
                    NSColor(deviceRed: 0.6, green: 0.3, blue: 0.1, alpha: 1).setFill()
                    NSRect(x: 100, y: 112, width: 56, height: 92).fill()
                }
            }
            try image.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("\(layer.id).png"))
        }
        let layers = base.layers.map { layer in RigManifest.Layer(id: layer.id, file: "\(layer.id).png", parent: layer.parent,
            pivot: layer.pivot, motion: layer.motion, amplitudeDegrees: layer.amplitudeDegrees) }
        let definition = RigManifest.Character(layers: layers, face: .init(file: "unused.png", frameHeight: 384,
            frames: LayeredRig.faceFrames, neutralOnly: true), motion: base.motion, skeleton: base.skeleton)
        guard let rig = LayeredRig(definition: definition, directory: directory) else {
            FileHandle.standardError.write(Data("FAIL synthetic joint rig did not load\n".utf8)); exit(1)
        }
        let half = pixels(size: 1) {
            rig.draw(in: NSRect(origin: .zero, size: SpriteGeometry.size), pose: LayerPose(), time: 0, gestureElapsed: nil,
                reduced: true, opacity: 0.5, radius: 0, faceRows: [], sprites: SpriteCache())
        }
        let alpha = half.colorAt(x: 125, y: 220)!.alphaComponent
        FileHandle.standardError.write(Data("Joint alpha at 50% fade: \(alpha)\n".utf8))
        if abs(alpha - 128.0 / 255) >= 2.0 / 255 {
            FileHandle.standardError.write(Data("FAIL layer overlap makes a visible joint during a fade\n".utf8)); exit(1)
        }
        let blended = pixels(size: 1) {
            let context = NSGraphicsContext.current!.cgContext
            context.setAlpha(0.5); context.beginTransparencyLayer(auxiliaryInfo: nil)
            for weight in [0.37, 0.63] {
                rig.draw(in: NSRect(origin: .zero, size: SpriteGeometry.size), pose: LayerPose(), time: 0, gestureElapsed: nil,
                    reduced: true, opacity: weight, radius: 0, faceRows: [], sprites: SpriteCache(), compositing: .plusLighter)
            }
            context.endTransparencyLayer()
        }
        precondition(abs(blended.colorAt(x: 125, y: 220)!.alphaComponent - alpha) < 2.0 / 255,
            "Pose blend exposed background or darkened a joint")
    }

    /// Identical silhouettes with different authored periods cannot move abruptly at a view's midpoint.
    static func clockContinuity() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pose-clock-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        for (id, box) in [("body", NSRect(x: 104, y: 24, width: 48, height: 256)),
                          ("head", NSRect(x: 102, y: 248, width: 52, height: 96))] {
            let bitmap = pixels(size: 1) {
                NSColor(deviceRed: 0.6, green: 0.3, blue: 0.1, alpha: 1).setFill(); box.fill()
            }
            try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent(id + ".png"))
        }
        func definition(_ period: Double) -> [String: Any] {
            ["layers": [["id": "body", "file": "body.png", "pivot": [128, 368], "motion": "body", "amplitudeDegrees": 0],
                        ["id": "head", "file": "head.png", "parent": "body", "pivot": [128, 120], "motion": "head", "amplitudeDegrees": 1]],
             "face": ["file": "unused.png", "frameHeight": 384, "frames": LayeredRig.faceFrames, "neutralOnly": true],
             "motion": ["breathSeconds": period, "gestureSeconds": 3.6, "gestureIntervalSeconds": [8, 15]]]
        }
        for (name, key, period) in [("manifest.json", "code", 4.8), ("choreography.json", "code/work-three-quarter", 0.2)] {
            try JSONSerialization.data(withJSONObject: ["version": 1, "canvas": ["width": 256, "height": 384],
                "characters": [key: definition(period)]]).write(to: directory.appendingPathComponent(name))
        }
        let view = CharacterView(frame: NSRect(x: 0, y: 0, width: 168, height: 330))
        let actor = Character(id: "pose-clock", column: 1, label: "CODE", state: "working", rig: "code", invocationID: "clock", activity: "read")
        view.loadRigs(directory: directory); view.snapshotTime = 0; view.replace([actor], animated: false)
        view.snapshotTime = 1.2; view.tick()
        let midpoint = 1.2 + ChoreographyClips.standard.work.settleSeconds / 2
        func capture(_ time: Double) -> NSBitmapImageRep {
            view.snapshotTime = time; view.tick()
            let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
            view.cacheDisplay(in: view.bounds, to: bitmap); return bitmap
        }
        let before = capture(midpoint - 0.00001), after = capture(midpoint + 0.00001)
        precondition(before.pixelsWide == after.pixelsWide && before.pixelsHigh == after.pixelsHigh)
        var changed = 0, surface = 0
        for y in 0..<before.pixelsHigh * 4 / 5 { for x in 0..<before.pixelsWide {
            let a = before.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!, b = after.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
            if a.alphaComponent > 0.5 { surface += 1 }
            if abs(a.alphaComponent - b.alphaComponent) > 4.0 / 255 { changed += 1 }
        } }
        precondition(surface > 1_000, "Clock continuity rendered no body")
        FileHandle.standardError.write(Data("View midpoint: \(changed) changed alpha pixels / \(surface) solid pixels\n".utf8))
        precondition(changed <= 12, "View-specific motion clock snapped at the transition midpoint")
        print("PASS native view midpoint preserves the role's breathing clock and cutout ground")
    }

    /// Real cloth contains RGB detail: a solid-alpha check alone cannot detect coloured triangle edges.
    static func textureContinuity(_ directory: URL) {
        let definition = LayeredRig.definitions(directory: directory, manifest: "poses.json")["lead/reclining"]!
        let layers = definition.layers.map { ($0, NSImage(contentsOf: directory.appendingPathComponent($0.file))!) }
        let rig = SkeletalRig(definition: definition.skeleton!, layers: layers)!
        let body = layers.first { $0.0.id == "body" }!.1
        let prepared = SpriteCache().frame(body, column: 0, row: 0, rows: 1, radius: 0.8, columns: 1, light: 0)!
        var cases = 0, samples = 0, outliers = 0
        for image in [body, prepared] {
            var box = NSRect(origin: .zero, size: image.size)
            let cg = image.cgImage(forProposedRect: &box, context: nil, hints: nil)!
            for scale in [0.6875, 1.0, 1.375, 2.0] { for phase in 0..<12 {
                autoreleasepool {
                let transforms = rig.transforms(["pelvis": BoneOffset(angle: Double(phase) * 0.11,
                    x: 0.2, y: Double(phase) * 0.13)]), matrix = transforms["pelvis"]!
                // A root-only movement must match a single image transform on both raw and prepared art.
                let affine = CGAffineTransform(a: matrix.a, b: -matrix.b, c: -matrix.c, d: matrix.d,
                    tx: matrix.c * 384 + matrix.tx, ty: 384 * (1 - matrix.d) - matrix.ty)
                func render(mesh: Bool) -> NSBitmapImageRep {
                    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 600, pixelsHigh: 800,
                        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
                    bitmap.bitmapData!.initialize(repeating: 0, count: bitmap.bytesPerRow * bitmap.pixelsHigh)
                    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
                    NSGraphicsContext.current!.imageInterpolation = .none
                    let context = NSGraphicsContext.current!.cgContext
                    context.translateBy(x: 5.15, y: 7.37); context.scaleBy(x: scale, y: scale)
                    if mesh { rig.draw(image, layer: "body", in: NSRect(origin: .zero, size: SpriteGeometry.size),
                        transforms: transforms, opacity: 1) }
                    else { context.concatenate(affine); context.draw(cg, in: NSRect(origin: .zero, size: SpriteGeometry.size)) }
                    NSGraphicsContext.restoreGraphicsState(); return bitmap
                }
                let reference = render(mesh: false), actual = render(mesh: true)
                let expected = reference.bitmapData!, result = actual.bitmapData!
                var errors = Set<Int>(), checked = 0
                for y in 4..<796 { for x in 4..<596 {
                    let index = y * reference.bytesPerRow + x * 4
                    guard expected[index + 3] > 250, [-2, -1, 1, 2].allSatisfy({
                        expected[index + $0 * 4 + 3] > 250 && expected[index + $0 * reference.bytesPerRow + 3] > 250
                    }) else { continue }
                    checked += 1
                    check(result[index + 3] > 250, "White mesh gap inside LEAD cloth at scale \(scale), phase \(phase), pixel \(x),\(y): alpha \(result[index + 3])")
                    if (0..<3).contains(where: { abs(Int(expected[index + $0]) - Int(result[index + $0])) > 2 }) {
                        errors.insert(index)
                    }
                } }
                check(checked > 3_000, "Texture continuity rendered no real cloth")
                // Exact texel-centre ties are isolated; a seam repeats or forms a connected line.
                check(errors.count <= max(1, checked / 10_000), "Repeated RGB mesh errors: \(errors.count)/\(checked) at scale \(scale), phase \(phase)")
                for pixel in errors {
                    var neighbours = 0
                    for dy in -1...1 { for dx in -1...1 where dx != 0 || dy != 0 {
                        if errors.contains(pixel + dy * reference.bytesPerRow + dx * 4) { neighbours += 1 }
                    } }
                    check(neighbours < 2, "Connected RGB segment inside real cloth at scale \(scale), phase \(phase)")
                }
                samples += checked; outliers += errors.count; cases += 1
                }
            } }
        }
        print("PASS real LEAD cloth: \(cases) fractional-scale/rotation cases, \(samples) opaque RGB samples, no white gaps or coloured segments; \(outliers) isolated nearest-texel ties")
    }

    /// Shared-edge rendering preserves each authored pixel on a scaled Retina backing store.
    static func retinaDetail(_ base: RigManifest.Character) {
        let texture = NSImage(size: SpriteGeometry.size)
        texture.addRepresentation(pixels(size: 1) {
            for y in 20..<340 { for x in 40..<216 {
                ((x + y) % 2 == 0 ? NSColor.systemOrange : NSColor.systemCyan).setFill()
                NSRect(x: x, y: y, width: 1, height: 1).fill()
            } }
        })
        var rect = NSRect(origin: .zero, size: texture.size)
        let cg = texture.cgImage(forProposedRect: &rect, context: nil, hints: nil)!
        let rig = SkeletalRig(definition: base.skeleton!, layers: base.layers.map { ($0, texture) })!
        let transforms = rig.transforms(["pelvis": BoneOffset(angle: 0.33, x: 0.2, y: 0.73)])
        let matrix = transforms["pelvis"]!, target = NSRect(origin: .zero, size: SpriteGeometry.size)
        let affine = CGAffineTransform(a: matrix.a, b: -matrix.b, c: -matrix.c, d: matrix.d,
            tx: matrix.c * 384 + matrix.tx, ty: 384 * (1 - matrix.d) - matrix.ty)
        let panel = NSPanel(contentRect: NSRect(x: 10, y: 10, width: 384, height: 576),
            styleMask: [.borderless], backing: .buffered, defer: false)
        defer { panel.close() }
        func capture(mesh: Bool) -> NSBitmapImageRep {
            let view = SurfaceView(frame: panel.contentView!.bounds) {
                let context = NSGraphicsContext.current!.cgContext
                NSGraphicsContext.current!.imageInterpolation = .none
                if mesh { rig.draw(texture, layer: "body", in: target, transforms: transforms, opacity: 1) }
                else { context.concatenate(affine); context.draw(cg, in: target) }
            }
            panel.contentView = view; view.setBoundsSize(SpriteGeometry.size)
            let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
            view.cacheDisplay(in: view.bounds, to: bitmap); return bitmap
        }
        let reference = capture(mesh: false), actual = capture(mesh: true)
        check(reference.pixelsWide == actual.pixelsWide && reference.pixelsHigh == actual.pixelsHigh, "Retina snapshot size changed")
        check(reference.bitsPerSample == 8 && reference.samplesPerPixel == 4 && reference.bitmapFormat == actual.bitmapFormat,
            "Unexpected native bitmap format")
        let expected = reference.bitmapData!, result = actual.bitmapData!
        let alpha = reference.bitmapFormat.contains(.alphaFirst) ? 0 : 3
        var checked = 0, errors = 0
        for y in 10..<reference.pixelsHigh - 10 { for x in 10..<reference.pixelsWide - 10 {
            let index = y * reference.bytesPerRow + x * 4
            guard expected[index + alpha] > 250, [-4, 4].allSatisfy({
                expected[index + $0 * 4 + alpha] > 250 && expected[index + $0 * reference.bytesPerRow + alpha] > 250
            }) else { continue }
            checked += 1
            if (0..<4).contains(where: { abs(Int(expected[index + $0]) - Int(result[index + $0])) > 2 }) { errors += 1 }
        } }
        check(checked > 30_000, "Retina detail rendered no texture")
        check(errors <= 2, "Native rendering lost Retina detail: \(errors)/\(checked) pixels")
        print("PASS native window \(panel.backingScaleFactor)x backing: \(checked) checker pixels preserve full device detail")
    }

    static func main() throws {
        _ = NSApplication.shared
        let directory = URL(fileURLWithPath: CommandLine.arguments[1])
        registration(directory)
        let base = LayeredRig.definitions(directory: directory, manifest: "manifest.json")["code"]!
        try jointOpacity(base)
        try clockContinuity()
        textureContinuity(directory)
        retinaDetail(base)
        let texture = NSImage(size: SpriteGeometry.size)
        texture.addRepresentation(pixels(size: 1) {
            NSColor(deviceRed: 0.6, green: 0.3, blue: 0.1, alpha: 1).setFill()
            NSRect(x: 40, y: 20, width: 176, height: 280).fill()
        })
        let skeleton = SkeletalRig(definition: base.skeleton!, layers: base.layers.map { ($0, texture) })!
        var defects = 0, samples = 0, worst = 0.0
        for size in [1, 2, 4] { for frame in 0..<12 {
            let phase = Double(frame) * .pi / 6
            let offsets = ["pelvis": BoneOffset(angle: 3 * sin(phase), x: 0.35, y: 0.65),
                "spine": BoneOffset(angle: 3 * cos(phase)), "chest": BoneOffset(angle: -2 * sin(phase)),
                "thigh-left": BoneOffset(angle: sin(phase) * 6), "shin-right": BoneOffset(angle: cos(phase) * 6)]
            let bitmap = pixels(size: size) {
                skeleton.draw(texture, layer: "body", in: NSRect(origin: .zero, size: SpriteGeometry.size),
                    transforms: skeleton.transforms(offsets), opacity: 0.5)
            }
            for y in (100 * size)..<(300 * size) {
                let xs = (0..<bitmap.pixelsWide).filter { bitmap.colorAt(x: $0, y: y)!.alphaComponent > 0.1 }
                guard let lo = xs.first, let hi = xs.last, hi - lo > 16 * size else { continue }
                for x in (lo + 6 * size)..<(hi - 6 * size) {
                    let alpha = bitmap.colorAt(x: x, y: y)!.alphaComponent
                    let error = abs(alpha - 128.0 / 255)
                    samples += 1; worst = max(worst, error)
                    if error > 2.0 / 255 { defects += 1 }
                }
            }
        } }
        print("Deformed surface: \(defects) interior alpha defects / \(samples) samples; worst \(worst)")
        precondition(defects == 0, "Visible triangle seams in deformed translucent surface")
        print("PASS deformed opaque interiors retain uniform opacity across shared triangle edges at 1x/2x/4x")
    }
}
