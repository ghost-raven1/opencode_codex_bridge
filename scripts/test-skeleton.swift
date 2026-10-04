import AppKit

@main struct SkeletonTests {
    static func check(_ condition: Bool, _ message: String = "Skeleton assertion failed", line: UInt = #line) {
        if !condition { FileHandle.standardError.write(Data("FAIL skeleton:\(line): \(message)\n".utf8)); exit(1) }
    }
    static func near(_ a: CGPoint, _ b: CGPoint, limit: Double = 0.0001, _ reason: String) {
        check(hypot(a.x - b.x, a.y - b.y) < limit, "\(reason): \(a) != \(b)")
    }
    static func bitmap(_ draw: () -> Void) -> NSBitmapImageRep {
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 256, pixelsHigh: 384,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0)!
        bitmap.bitmapData!.initialize(repeating: 0, count: bitmap.bytesPerRow * 384)
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        NSGraphicsContext.current?.imageInterpolation = .none; draw(); NSGraphicsContext.restoreGraphicsState()
        return bitmap
    }
    /// Put a cast shadow just past a translated torso's old boundary; preserve the same cached soft contour in the control.
    static func shadowBoundary(_ base: RigManifest.Character) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("skeletal-shadow-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let layers = try base.layers.map { layer -> RigManifest.Layer in
            let file = "\(layer.id).png"
            let pixels = bitmap {
                NSColor(deviceRed: 0.4, green: 0.4, blue: 0.4, alpha: 1).setFill()
                if layer.id == "body" { NSRect(x: 100, y: 112, width: 56, height: 92).fill() }
                if layer.id == "arm-left" { NSRect(x: 146, y: 159, width: 20, height: 5).fill() }
            }
            try pixels.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent(file))
            return RigManifest.Layer(id: layer.id, file: file, parent: layer.parent, pivot: layer.pivot,
                                     motion: layer.motion, amplitudeDegrees: layer.amplitudeDegrees)
        }
        let definition = RigManifest.Character(layers: layers,
            face: RigManifest.Face(file: "unused.png", frameHeight: 384, frames: LayeredRig.faceFrames, neutralOnly: true),
            motion: base.motion, skeleton: base.skeleton)
        let rig = LayeredRig(definition: definition, directory: directory)!, skeleton = rig.skeleton!
        let target = NSRect(origin: .zero, size: SpriteGeometry.size), offsets = ["pelvis": BoneOffset(x: -6, y: 4)]
        let transforms = skeleton.transforms(offsets)
        let expected = bitmap {
            let cache = SpriteCache()
            for layer in layers {
                let image = NSImage(contentsOf: directory.appendingPathComponent(layer.file))!
                let prepared = cache.frame(image, column: 0, row: 0, rows: 1, radius: 0, columns: 1, light: 0)!
                if layer.motion == "head" || layer.parent == "head" {
                    skeleton.drawRigid(prepared, in: target, bone: "head", reference: target, transforms: transforms, opacity: 1)
                } else { skeleton.draw(prepared, layer: layer.id, in: target, transforms: transforms, opacity: 1) }
            }
        }
        let shaded = bitmap {
            rig.draw(in: target, pose: LayerPose(), time: 0, gestureElapsed: nil, reduced: false,
                opacity: 1, radius: 0, faceRows: [], sprites: SpriteCache(), boneOffsets: offsets)
        }
        var leaks = 0
        for y in 0..<384 { for x in 0..<256 {
            if shaded.colorAt(x: x, y: y)!.alphaComponent > expected.colorAt(x: x, y: y)!.alphaComponent + 0.03 { leaks += 1 }
        } }
        check(leaks == 0, "Synthetic cast shadow leaked past moving torso: \(leaks) pixels")
    }
    static func main() throws {
        _ = NSApplication.shared
        let directory = URL(fileURLWithPath: CommandLine.arguments[1])
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("skeletons.json"))) as! [String: Any]
        let characters = raw["characters"] as! [String: [String: Any]]
        check(characters.count == 91, "Missing shipped skeletal views")
        let base = LayeredRig.load(directory: directory), poses = PoseRigLibrary(directory: directory)
        var moving = Set<String>(), maxSupportError = 0.0
        for key in characters.keys.sorted() {
            let rig = key.contains("/") ? poses.rig(key) : base[key]
            guard let rig, let skeleton = rig.skeleton else { preconditionFailure("Skeleton did not load: \(key)") }
            let bind = skeleton.transforms([:])
            for bone in skeleton.definition.bones { near(bind[bone.id]!.point(bone.point), bone.point, "Bind pose changed artwork") }
            let role = String(key.split(separator: "/")[0]), posture = key.split(separator: "/").dropFirst().first.map(String.init) ?? "standing"
            for frame in 0..<60 {
                let time = Double(frame) / 30
                let offsets = SkeletalMotion.offsets(rig: skeleton, role: role, posture: "standing", time: time,
                    seed: 7, head: LayerPose(), work: WorkPose(), music: MusicPose(), beat: nil, speaking: false, reduced: false)
                let matrices = skeleton.transforms(offsets)
                for side in ["left", "right"] {
                    let hip = skeleton.bones["thigh-\(side)"]!.point, knee = skeleton.bones["shin-\(side)"]!.point
                    let ankle = skeleton.bones["foot-\(side)"]!.point
                    let a = matrices["thigh-\(side)"]!.point(hip), b = matrices["shin-\(side)"]!.point(knee)
                    let c = matrices["foot-\(side)"]!.point(ankle)
                    check(abs(hypot(a.x - b.x, a.y - b.y) - hypot(hip.x - knee.x, hip.y - knee.y)) < 0.0001)
                    check(abs(hypot(b.x - c.x, b.y - c.y) - hypot(knee.x - ankle.x, knee.y - ankle.y)) < 0.0001)
                    let error = hypot(c.x - ankle.x, c.y - ankle.y)
                    maxSupportError = max(maxSupportError, error)
                    check(error < 0.08, "Planted ankle drifted: \(key)/\(side) \(error)")
                    if hypot(b.x - knee.x, b.y - knee.y) > 0.15 { moving.insert(key) }
                }
                let reduced = SkeletalMotion.offsets(rig: skeleton, role: role, posture: posture, time: time,
                    seed: 7, head: LayerPose(headX: 9), work: WorkPose(bodyAngle: 5), music: MusicPose(strength: 1),
                    beat: nil, speaking: false, reduced: true)
                check(reduced.isEmpty, "Reduce Motion animated a bone")
            }
        }
        check(moving.count == 91, "Unused skeletons: \(Set(characters.keys).subtracting(moving))")
        let rig = base["code"]!, skeleton = rig.skeleton!
        try shadowBoundary(rig.definition)
        let canvas = NSRect(origin: .zero, size: SpriteGeometry.size)
        func volume(_ turn: Double) -> NSBitmapImageRep {
            bitmap {
                rig.draw(in: canvas, pose: LayerPose(), time: 0, gestureElapsed: nil, reduced: false,
                    opacity: 1, radius: 0, faceRows: [], sprites: SpriteCache(), depth: DepthPose(headTurn: turn), boneOffsets: [:])
            }
        }
        let frontal = volume(0), turned = volume(0.65)
        var movedHeadPixels = 0
        for y in 0..<384 { for x in 0..<256 {
            let difference = abs(frontal.colorAt(x: x, y: y)!.alphaComponent - turned.colorAt(x: x, y: y)!.alphaComponent)
            if y < 100 && difference > 0.03 { movedHeadPixels += 1 }
            if y > 250 { check(difference < 0.03, "Turning a skeletal head moved the feet") }
        } }
        check(movedHeadPixels > 30, "Skeletal head lost its authored foreground perspective")
        // Moving a skinned torso must not leave cast shadows clipped to its old silhouette.
        let moved = skeleton.transforms(["pelvis": BoneOffset(x: 6, y: 4)])
        let box = NSRect(origin: .zero, size: SpriteGeometry.size)
        let expected = bitmap {
            let cache = SpriteCache()
            for layer in rig.definition.layers {
                let image = NSImage(contentsOf: directory.appendingPathComponent(layer.file))!
                let prepared = cache.frame(image, column: 0, row: 0, rows: 1, radius: 0, columns: 1, light: 0)!
                if layer.motion == "head" || layer.parent == "head" {
                    skeleton.drawRigid(prepared, in: box, bone: "head", reference: box, transforms: moved, opacity: 1)
                } else { skeleton.draw(prepared, layer: layer.id, in: box, transforms: moved, opacity: 1) }
            }
        }
        let shaded = bitmap {
            rig.draw(in: box, pose: LayerPose(), time: 0, gestureElapsed: nil, reduced: false,
                opacity: 1, radius: 0, faceRows: [], sprites: SpriteCache(), boneOffsets: ["pelvis": BoneOffset(x: 6, y: 4)])
        }
        var leaks = 0
        for y in 0..<384 { for x in 0..<256 {
            if shaded.colorAt(x: x, y: y)!.alphaComponent > expected.colorAt(x: x, y: y)!.alphaComponent + 0.03 { leaks += 1 }
        } }
        check(leaks == 0, "Cast shadows leaked outside the deformed silhouette: \(leaks) pixels")
        let parent = skeleton.transforms(["pelvis": BoneOffset(x: 1, y: 2)])
        near(parent["head"]!.point(skeleton.bones["head"]!.point),
             CGPoint(x: skeleton.bones["head"]!.point.x + 1, y: skeleton.bones["head"]!.point.y + 2), "Head ignored pelvis")
        let arm = skeleton.transforms(["upper-arm-left": BoneOffset(angle: 5), "forearm-left": BoneOffset(angle: 9)])
        let elbow = skeleton.bones["forearm-left"]!.point
        near(arm["forearm-left"]!.point(elbow), arm["upper-arm-left"]!.point(elbow), "Elbow detached from upper arm")
        for frame in 0..<120 {
            let time = Double(frame) / 60, gait = time * 2 * .pi / ChoreographyClips.standard.walk.stepSeconds
            let offsets = SkeletalMotion.offsets(rig: skeleton, role: "code", posture: "walk-left", time: time,
                seed: 7, head: LayerPose(), work: WorkPose(), music: MusicPose(), beat: nil, speaking: false, reduced: false)
            let matrices = skeleton.transforms(offsets)
            for (index, side) in ["left", "right"].enumerated() {
                let swing = pow(max(0, sin(gait + Double(index) * .pi)), 2), ankle = skeleton.bones["foot-\(side)"]!.point
                near(matrices["foot-\(side)"]!.point(ankle), CGPoint(x: ankle.x + swing * cos(gait + Double(index) * .pi) * 2.5,
                     y: ankle.y - swing * 4), limit: 0.08, "Walk support/swing target")
            }
        }
        // A translucent rectangle reveals both cracks and twice-composited mesh edges.
        let texture = NSImage(size: SpriteGeometry.size)
        texture.addRepresentation(bitmap {
            NSColor(deviceRed: 0.6, green: 0.3, blue: 0.1, alpha: 1).setFill()
            NSRect(x: 40, y: 20, width: 176, height: 280).fill()
        })
        let definition = try JSONDecoder().decode(SkeletonDefinition.self, from: JSONSerialization.data(withJSONObject: characters["code"]!))
        let body = rig.definition.layers.first { $0.id == "body" }!
        let layers = rig.definition.layers.map { ($0, texture) }
        let synthetic = SkeletalRig(definition: definition, layers: layers)!
        let target = NSRect(origin: .zero, size: SpriteGeometry.size)
        let plain = bitmap { texture.draw(in: target.offsetBy(dx: 1, dy: -1), from: .zero, operation: .sourceOver, fraction: 0.5) }
        let skinned = bitmap { synthetic.draw(texture, layer: body.id, in: target,
            transforms: synthetic.transforms(["pelvis": BoneOffset(x: 1, y: 1)]), opacity: 0.5) }
        for y in 0..<384 { for x in 0..<256 {
            let a = plain.colorAt(x: x, y: y)!.alphaComponent, b = skinned.colorAt(x: x, y: y)!.alphaComponent
            check(abs(a - b) < 0.01, "Skinning opened a crack or drew a seam twice at \(x),\(y): \(a),\(b)")
        } }
        for mutation in ["cycle", "unknown-weight", "reversed-chain", "negative-limit", "zero-length-leg"] {
            var value = characters["code"]!, bones = value["bones"] as! [[String: Any]], skins = value["skins"] as! [[String: Any]]
            if mutation == "cycle" { bones[0]["parent"] = "head" }
            if mutation == "negative-limit" { bones[0]["limit"] = -1 }
            if mutation == "zero-length-leg" {
                let hip = bones.first { $0["id"] as? String == "thigh-left" }!["origin"]!
                bones[bones.firstIndex { $0["id"] as? String == "shin-left" }!]["origin"] = hip
            }
            if mutation == "unknown-weight" { skins[0]["chains"] = [["missing"]] }
            if mutation == "reversed-chain" { skins[0]["chains"] = [["foot-left", "thigh-left"]] }
            value["bones"] = bones; value["skins"] = skins
            let bad = try JSONDecoder().decode(SkeletonDefinition.self, from: JSONSerialization.data(withJSONObject: value))
            check(SkeletalRig(definition: bad, layers: layers) == nil, "Invalid skeleton accepted: \(mutation)")
        }
        for role in CompanionRig.names {
            check(poses.rig("\(role)/work-seated")?.skeleton == nil && poses.rig("\(role)/work-kneeling")?.skeleton == nil,
                         "Standing skinning deformed a seated/kneeling pose")
        }
        print("PASS 91 full skeletons, 17+ bones, connected parent joints, fixed-length IK, planted/swing feet, continuous-alpha mesh, invalid rig fallback and Reduce Motion; max support error \(maxSupportError) px")
    }
}
