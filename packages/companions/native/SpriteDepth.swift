import AppKit

/// Small perspective changes share joint pivots, so cutouts cannot detach at the neck or shoulder.
struct DepthPose {
    var turn: Double = 0
    var headTurn: Double = 0
    func light(head: Bool) -> Int {
        let value = head ? headTurn : turn
        return value < -0.18 ? -1 : value > 0.18 ? 1 : 0
    }
}

/// Prepare small lighting cues once; animation only composites the resulting images.
enum SpriteDepth {
    private struct Pixels {
        let width: Int
        let height: Int
        var bytes: [UInt8]

        init?(_ image: NSImage) {
            var rect = NSRect(origin: .zero, size: image.size)
            guard let source = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return nil }
            width = source.width; height = source.height
            bytes = Array(repeating: 0, count: width * height * 4)
            let width = width, height = height
            let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
                guard let context = CGContext(data: buffer.baseAddress, width: width, height: height,
                    bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
                context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height)); return true
            }
            if !drawn { return nil }
        }

        init(width: Int, height: Int) {
            self.width = width; self.height = height
            bytes = Array(repeating: 0, count: width * height * 4)
        }

        var image: NSImage? {
            guard let provider = CGDataProvider(data: Data(bytes) as CFData),
                  let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                    bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
                    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { return nil }
            return NSImage(cgImage: image, size: NSSize(width: width, height: height))
        }
    }

    /// A rounded surface normal follows each alpha span; ink and authored highlights stay readable.
    static func volume(_ source: NSImage, light: Int = 0) -> NSImage {
        guard var pixels = Pixels(source) else { return source }
        for y in 0..<pixels.height {
            var x = 0
            while x < pixels.width {
                while x < pixels.width && pixels.bytes[(y * pixels.width + x) * 4 + 3] == 0 { x += 1 }
                let start = x
                while x < pixels.width && pixels.bytes[(y * pixels.width + x) * 4 + 3] > 0 { x += 1 }
                let length = x - start
                guard length >= 5 else { continue }
                for column in start..<x {
                    let offset = (y * pixels.width + column) * 4, alpha = Double(pixels.bytes[offset + 3])
                    let u = Double(column - start) / Double(length - 1)
                    let v = Double(y) / Double(max(1, pixels.height - 1))
                    let theta = (u - 0.5) * .pi * 0.8
                    let diffuse = sin(theta) * (-0.48 + Double(min(1, max(-1, light))) * 0.08) + cos(theta) * 0.85
                    let shade = max(0, 0.88 - diffuse) * 0.30 + 0.035 * v
                    let rim = column - start < 2 ? 0.025 : 0.0
                    let highlight = max(0, diffuse - 0.60) * 0.25 + rim
                    for channel in 0..<3 {
                        let value = Double(pixels.bytes[offset + channel])
                        pixels.bytes[offset + channel] = UInt8(min(alpha, max(0,
                            value * (1 - shade) + (alpha - value) * highlight * sqrt(value / alpha))).rounded())
                    }
                }
            }
        }
        return pixels.image ?? source
    }

    /// Cache soft alpha-only cast shadows. The receiver is clipped at draw time, after joint motion.
    static func shadow(_ source: NSImage) -> NSImage? {
        guard let source = Pixels(source) else { return nil }
        var result = Pixels(width: source.width, height: source.height)
        let weights = [1.0, 4.0, 6.0, 4.0, 1.0]
        var horizontal = Array(repeating: 0.0, count: source.width * source.height)
        for y in 0..<source.height { for x in 0..<source.width {
            for dx in -2...2 where x + dx >= 0 && x + dx < source.width {
                horizontal[y * source.width + x] += Double(source.bytes[(y * source.width + x + dx) * 4 + 3]) * weights[dx + 2] / 16
            }
        } }
        for y in 0..<source.height { for x in 0..<source.width {
            var alpha = 0.0
            for dy in -2...2 where y + dy >= 0 && y + dy < source.height {
                alpha += horizontal[(y + dy) * source.width + x] * weights[dy + 2] / 16
            }
            result.bytes[(y * source.width + x) * 4 + 3] = UInt8((alpha * 0.24).rounded())
        } }
        return result.image
    }

    static func pose(time: Double, seed: Int, headX: Double, headAngle: Double, reduced: Bool) -> DepthPose {
        guard !reduced else { return DepthPose() }
        let turn = min(0.65, max(-0.65, sin(time * 0.32 + Double(seed) * 0.7) * 0.28 + headX * 0.06))
        return DepthPose(turn: turn, headTurn: min(0.7, max(-0.7, turn + headAngle * 0.035)))
    }

    /// Grounded torso perspective; foreground parts project further, around their fixed joint.
    static func projection(pivot: [Double], target: NSRect, turn: Double, foreground: Bool = false) -> NSAffineTransform {
        let turn = min(1, max(-1, turn))
        let point = NSPoint(x: target.minX + pivot[0] * target.width / 256,
                            y: target.minY + (384 - pivot[1]) * target.height / 384)
        let transform = NSAffineTransform()
        let scale = 1 - abs(turn) * (foreground ? 0.045 : 0.035), shear = turn * (foreground ? 0.025 : 0.012)
        transform.transformStruct = NSAffineTransformStruct(m11: scale, m12: 0, m21: shear, m22: 1,
            tX: point.x * (1 - scale) - point.y * shear, tY: 0)
        return transform
    }

    /// A cached transparent ellipse anchors the feet without a hard halo on either background.
    static let contact: NSImage? = {
        var pixels = Pixels(width: 128, height: 24)
        for y in 0..<pixels.height { for x in 0..<pixels.width {
            let dx = (Double(x) + 0.5 - 64) / 64, dy = (Double(y) + 0.5 - 12) / 12
            let falloff = max(0, 1 - dx * dx - dy * dy)
            pixels.bytes[(y * pixels.width + x) * 4 + 3] = UInt8((52 * falloff * falloff).rounded())
        } }
        return pixels.image
    }()

    static func drawContact(in target: NSRect, opacity: Double, turn: Double = 0) {
        let height = max(2, target.height * 0.022)
        let ground = target.minY + target.height * (16.0 / 384)
        let width = target.width * (0.64 - abs(turn) * 0.03)
        let rect = NSRect(x: target.midX - width / 2 + turn * target.width * 0.006, y: ground - height * 0.55,
                          width: width, height: height)
        contact?.draw(in: rect, from: .zero, operation: .sourceOver, fraction: opacity)
    }
}
