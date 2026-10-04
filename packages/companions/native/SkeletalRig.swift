import AppKit

/// Bind positions use the atlas's top-left coordinates. Parents precede children.
struct SkeletonDefinition: Decodable {
    struct Bone: Decodable {
        let id: String
        let parent: String?
        let origin: [Double]
        let limit: Double
        var point: CGPoint { CGPoint(x: origin[0], y: origin[1]) }
    }
    struct Skin: Decodable {
        let layer: String
        let chains: [[String]]
    }
    let bones: [Bone]
    let skins: [Skin]
}

struct SkeletonManifest: Decodable {
    let version: Int
    let canvas: RigManifest.Canvas
    let coordinates: String
    let characters: [String: SkeletonDefinition]
    static func read(directory: URL) -> [String: SkeletonDefinition] {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("skeletons.json")),
              let manifest = try? JSONDecoder().decode(Self.self, from: data), manifest.version == 1,
              manifest.canvas.width == SpriteGeometry.width, manifest.canvas.height == SpriteGeometry.height,
              manifest.coordinates == "top-left" else { return [:] }
        return manifest.characters
    }
}

/// Explicit parent × child multiplication avoids mixing AppKit's bottom-left and atlas coordinates.
struct BoneTransform {
    var a = 1.0, b = 0.0, c = 0.0, d = 1.0, tx = 0.0, ty = 0.0
    func point(_ p: CGPoint) -> CGPoint { CGPoint(x: a * p.x + c * p.y + tx, y: b * p.x + d * p.y + ty) }
    var angle: Double { atan2(b, a) * 180 / .pi }
    func following(_ local: BoneTransform) -> BoneTransform {
        BoneTransform(a: a * local.a + c * local.b, b: b * local.a + d * local.b,
                      c: a * local.c + c * local.d, d: b * local.c + d * local.d,
                      tx: a * local.tx + c * local.ty + tx, ty: b * local.tx + d * local.ty + ty)
    }
    static func joint(_ bone: SkeletonDefinition.Bone, _ offset: BoneOffset) -> BoneTransform {
        let r = (offset.angle.isFinite ? min(bone.limit, max(-bone.limit, offset.angle)) : 0) * .pi / 180
        let c = cos(r), s = sin(r), p = bone.point
        let limit = bone.id == "pelvis" ? 6.0 : 1.5
        let x = offset.x.isFinite ? min(limit, max(-limit, offset.x)) : 0
        let y = offset.y.isFinite ? min(limit, max(-limit, offset.y)) : 0
        return BoneTransform(a: c, b: s, c: -s, d: c,
                             tx: p.x - c * p.x + s * p.y + x, ty: p.y - s * p.x - c * p.y + y)
    }
}

/// Cached bind mesh/weights; a frame changes only bone matrices and existing texture coordinates.
final class SkeletalRig {
    struct Vertex { let point: CGPoint; let weights: [(String, Double)] }
    struct Mesh { let vertices: [Vertex]; let triangles: [[Int]] }
    let definition: SkeletonDefinition
    let bones: [String: SkeletonDefinition.Bone]
    private let bindings: [String: SkeletonDefinition.Skin]
    private let meshes: [String: Mesh]

    init?(definition: SkeletonDefinition, layers: [(RigManifest.Layer, NSImage)]) {
        guard (1...32).contains(definition.bones.count), definition.bones.first?.id == "pelvis",
              definition.bones.first?.parent == nil,
              Set(definition.bones.map(\.id)).count == definition.bones.count,
              Set(definition.skins.map(\.layer)).count == definition.skins.count else { return nil }
        var checked: [String: SkeletonDefinition.Bone] = [:]
        for bone in definition.bones {
            guard !bone.id.isEmpty, bone.origin.count == 2, bone.origin.allSatisfy(\.isFinite),
                  (0...256).contains(bone.origin[0]), (0...384).contains(bone.origin[1]),
                  bone.limit.isFinite, (0...45).contains(bone.limit),
                  bone.id == "pelvis" || bone.parent.flatMap({ checked[$0] }) != nil else { return nil }
            checked[bone.id] = bone
        }
        let parents = ["spine": "pelvis", "chest": "spine", "neck": "chest", "head": "neck",
                       "upper-arm-left": "chest", "forearm-left": "upper-arm-left", "hand-left": "forearm-left",
                       "upper-arm-right": "chest", "forearm-right": "upper-arm-right", "hand-right": "forearm-right",
                       "thigh-left": "pelvis", "shin-left": "thigh-left", "foot-left": "shin-left",
                       "thigh-right": "pelvis", "shin-right": "thigh-right", "foot-right": "shin-right"]
        guard parents.allSatisfy({ checked[$0.key]?.parent == $0.value }) else { return nil }
        for side in ["left", "right"] {
            let a = checked["thigh-\(side)"]!.point, b = checked["shin-\(side)"]!.point, c = checked["foot-\(side)"]!.point
            guard hypot(a.x - b.x, a.y - b.y) > 1, hypot(b.x - c.x, b.y - c.y) > 1 else { return nil }
        }
        let images = Dictionary(uniqueKeysWithValues: layers.map { ($0.0.id, $0.1) })
        var meshes: [String: Mesh] = [:]
        for skin in definition.skins {
            guard let image = images[skin.layer], !skin.chains.isEmpty, skin.chains.count <= 5 else { return nil }
            for chain in skin.chains {
                guard !chain.isEmpty, chain.count <= 5, chain.allSatisfy({ checked[$0] != nil }),
                      Set(chain).count == chain.count else { return nil }
                for n in 1..<chain.count where checked[chain[n]]?.parent != chain[n - 1] { return nil }
            }
            if skin.chains.count != 1 || skin.chains[0].count != 1 {
                guard let mesh = Self.mesh(image: image, skin: skin, bones: checked) else { return nil }
                meshes[skin.layer] = mesh
            }
        }
        guard definition.skins.contains(where: { $0.layer == "body" }), checked["head"] != nil,
              ["left", "right"].allSatisfy({ checked["thigh-\($0)"] != nil && checked["shin-\($0)"] != nil && checked["foot-\($0)"] != nil }) else { return nil }
        self.definition = definition; bones = checked; self.meshes = meshes
        bindings = Dictionary(uniqueKeysWithValues: definition.skins.map { ($0.layer, $0) })
    }

    func transforms(_ offsets: [String: BoneOffset]) -> [String: BoneTransform] {
        var result: [String: BoneTransform] = [:]
        for bone in definition.bones {
            let parent = bone.parent.flatMap { result[$0] } ?? BoneTransform()
            result[bone.id] = parent.following(.joint(bone, offsets[bone.id] ?? BoneOffset()))
        }
        return result
    }

    /// Linear skinning across adjacent joints and nearby chains keeps cloth and cutout seams connected.
    private static func weights(_ p: CGPoint, skin: SkeletonDefinition.Skin, bones: [String: SkeletonDefinition.Bone]) -> [(String, Double)] {
        var branches: [(Double, [(String, Double)])] = []
        for chain in skin.chains {
            if chain.count == 1 { branches.append((1, [(chain[0], 1)])); continue }
            var nearest = Double.infinity, selected: [(String, Double)] = []
            for n in 0..<chain.count - 1 {
                let a = bones[chain[n]]!.point, b = bones[chain[n + 1]]!.point
                let dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy
                let t = length > 0 ? min(1, max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 1
                let distance = hypot(p.x - a.x - dx * t, p.y - a.y - dy * t)
                if distance < nearest {
                    nearest = distance
                    let smooth = t * t * (3 - 2 * t)
                    selected = [(chain[n], 1 - smooth), (chain[n + 1], smooth)]
                }
            }
            branches.append((pow(1 / (4 + nearest), 6), selected))
        }
        let sum = branches.reduce(0) { $0 + $1.0 }
        var result: [String: Double] = [:]
        for (strength, chain) in branches { for (id, w) in chain { result[id, default: 0] += w * strength / sum } }
        return result.sorted { $0.key < $1.key }
    }

    private static func mesh(image: NSImage, skin: SkeletonDefinition.Skin, bones: [String: SkeletonDefinition.Bone]) -> Mesh? {
        var rect = NSRect(origin: .zero, size: image.size)
        guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return nil }
        let pixels = NSBitmapImageRep(cgImage: cg)
        var minX = 256, maxX = 0, minY = 384, maxY = 0
        let alpha = pixels.bitmapFormat.contains(.alphaFirst) ? 0 : pixels.samplesPerPixel - 1
        for y in 0..<384 { for x in 0..<256 {
            let opaque: Bool
            if let bytes = pixels.bitmapData, pixels.bitsPerSample == 8, pixels.hasAlpha, !pixels.isPlanar {
                opaque = bytes[y * pixels.bytesPerRow + x * pixels.samplesPerPixel + alpha] > 0
            } else { opaque = (pixels.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0 }
            if opaque { minX = min(minX, x); maxX = max(maxX, x + 1); minY = min(minY, y); maxY = max(maxY, y + 1) }
        } }
        // Empty underlays are valid but contribute no triangles.
        guard minX < maxX, minY < maxY else { return Mesh(vertices: [], triangles: []) }
        // Prepared soft contours/shadows extend past the unprocessed texture's alpha bounds.
        minX = max(0, minX - 8); maxX = min(256, maxX + 8)
        minY = max(0, minY - 8); maxY = min(384, maxY + 8)
        let xCandidates = [Double(minX), Double(maxX), Double(bones["pelvis"]!.point.x),
                           Double(bones["foot-left"]!.point.x), Double(bones["foot-right"]!.point.x)]
        let yCandidates = [Double(minY), Double(maxY)] + ["chest", "spine", "pelvis", "shin-left", "shin-right", "foot-left", "foot-right"].compactMap { bones[$0].map { Double($0.point.y) } }
        let xs = Array(Set(xCandidates.filter { $0 >= Double(minX) && $0 <= Double(maxX) })).sorted()
        let ys = Array(Set(yCandidates.filter { $0 >= Double(minY) && $0 <= Double(maxY) })).sorted()
        var vertices: [Vertex] = [], triangles: [[Int]] = []
        for y in ys { for x in xs { let p = CGPoint(x: x, y: y); vertices.append(Vertex(point: p, weights: weights(p, skin: skin, bones: bones))) } }
        for row in 0..<ys.count - 1 { for col in 0..<xs.count - 1 {
            let a = row * xs.count + col, b = a + 1, c = a + xs.count, d = c + 1
            triangles += [[a, b, c], [b, d, c]]
        } }
        return Mesh(vertices: vertices, triangles: triangles)
    }

    /// Texture triangles share vertices; hard clipping prevents translucent seams and double blending.
    func draw(_ image: NSImage, layer: String, in target: NSRect, transforms: [String: BoneTransform], opacity: Double,
              operation: NSCompositingOperation = .sourceOver) {
        guard let binding = bindings[layer] else {
            image.draw(in: target, from: .zero, operation: operation, fraction: opacity); return
        }
        if transforms.values.allSatisfy({ $0.a == 1 && $0.b == 0 && $0.c == 0 && $0.d == 1 && $0.tx == 0 && $0.ty == 0 }) {
            image.draw(in: target, from: .zero, operation: operation, fraction: opacity); return
        }
        if let mesh = meshes[layer] {
            let points = mesh.vertices.map { vertex -> CGPoint in
                var p = CGPoint.zero
                for (id, weight) in vertex.weights {
                    let moved = transforms[id]!.point(vertex.point); p.x += moved.x * weight; p.y += moved.y * weight
                }
                return Self.destination(p, target)
            }
            guard let first = points.first else { return }
            var minX = first.x, maxX = first.x, minY = first.y, maxY = first.y
            for point in points { minX = min(minX, point.x); maxX = max(maxX, point.x); minY = min(minY, point.y); maxY = max(maxY, point.y) }
            let region = CGRect(x: minX - 1, y: minY - 1, width: maxX - minX + 2, height: maxY - minY + 2)
            guard let context = NSGraphicsContext.current?.cgContext else { return }
            var bounds = NSRect(origin: .zero, size: image.size)
            guard let texture = image.cgImage(forProposedRect: &bounds, context: nil, hints: nil) else { return }
            NSGraphicsContext.saveGraphicsState()
            context.setBlendMode(operation == .sourceAtop ? .sourceAtop : .normal); context.setAlpha(opacity)
            context.beginTransparencyLayer(in: region, auxiliaryInfo: nil)
            for triangle in mesh.triangles {
                let source = triangle.map { Self.destination(mesh.vertices[$0].point, target) }
                let dest = triangle.map { points[$0] }
                guard let affine = Self.affine(from: source, to: dest) else { continue }
                NSGraphicsContext.saveGraphicsState()
                context.setShouldAntialias(false)
                context.beginPath(); context.move(to: dest[0]); context.addLine(to: dest[1]); context.addLine(to: dest[2]); context.closePath(); context.clip()
                context.concatenate(affine)
                // Shared-edge pixels may be covered twice. Replace them before compositing the layer once.
                context.setBlendMode(.copy); context.draw(texture, in: target)
                NSGraphicsContext.restoreGraphicsState()
            }
            context.endTransparencyLayer(); NSGraphicsContext.restoreGraphicsState()
        } else { drawRigid(image, in: target, bone: binding.chains[0][0], reference: target,
            transforms: transforms, opacity: opacity, operation: operation) }
    }

    func drawRigid(_ image: NSImage, in destination: NSRect, bone: String, reference: NSRect,
                   transforms: [String: BoneTransform], opacity: Double, local: NSAffineTransform? = nil,
                   operation: NSCompositingOperation = .sourceOver) {
        guard let matrix = transforms[bone] else { return }
        let source = [CGPoint.zero, CGPoint(x: 256, y: 0), CGPoint(x: 0, y: 384)]
        let a = source.map { Self.destination($0, reference) }, b = source.map { Self.destination(matrix.point($0), reference) }
        guard let affine = Self.affine(from: a, to: b) else { return }
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current?.cgContext.concatenate(affine)
        local?.concat()
        image.draw(in: destination, from: .zero, operation: operation, fraction: opacity)
        NSGraphicsContext.restoreGraphicsState()
    }

    private static func destination(_ p: CGPoint, _ target: NSRect) -> CGPoint {
        CGPoint(x: target.minX + p.x * target.width / 256, y: target.minY + (384 - p.y) * target.height / 384)
    }

    private static func affine(from a: [CGPoint], to b: [CGPoint]) -> CGAffineTransform? {
        let p = a[1] - a[0], q = a[2] - a[0], u = b[1] - b[0], v = b[2] - b[0]
        let det = p.x * q.y - p.y * q.x
        guard abs(det) > 1e-8 else { return nil }
        let m11 = (u.x * q.y - v.x * p.y) / det, m12 = (u.y * q.y - v.y * p.y) / det
        let m21 = (v.x * p.x - u.x * q.x) / det, m22 = (v.y * p.x - u.y * q.x) / det
        return CGAffineTransform(a: m11, b: m12, c: m21, d: m22,
                                 tx: b[0].x - m11 * a[0].x - m21 * a[0].y, ty: b[0].y - m12 * a[0].x - m22 * a[0].y)
    }
}

private func - (lhs: CGPoint, rhs: CGPoint) -> CGPoint { CGPoint(x: lhs.x - rhs.x, y: lhs.y - rhs.y) }
