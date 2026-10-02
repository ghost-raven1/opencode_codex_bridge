import AppKit

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

    /// The cast shadow changes colour only inside the body's alpha; it cannot create stray pixels.
    static func body(_ source: NSImage, under occluders: [NSImage]) -> NSImage {
        guard var body = Pixels(source) else { return source }
        var mask = Array(repeating: UInt8(0), count: body.width * body.height)
        for image in occluders {
            guard let pixels = Pixels(image), pixels.width == body.width, pixels.height == body.height else { continue }
            for index in mask.indices { mask[index] = max(mask[index], pixels.bytes[index * 4 + 3]) }
        }
        let weights = [1.0, 2.0, 1.0]
        for y in 0..<body.height { for x in 0..<body.width {
            let offset = (y * body.width + x) * 4
            guard body.bytes[offset + 3] > 0 else { continue }
            var shade = 0.0
            for dy in -1...1 { for dx in -1...1 {
                let px = x - 2 + dx, py = y - 2 + dy
                if px >= 0, py >= 0, px < body.width, py < body.height {
                    shade += Double(mask[py * body.width + px]) * weights[dx + 1] * weights[dy + 1]
                }
            } }
            let factor = 1 - 0.10 * shade / (16 * 255)
            for channel in 0..<3 { body.bytes[offset + channel] = UInt8((Double(body.bytes[offset + channel]) * factor).rounded()) }
        } }
        return body.image ?? source
    }

    /// A cached transparent ellipse anchors the feet without a hard halo on either background.
    static let contact: NSImage? = {
        var pixels = Pixels(width: 128, height: 24)
        for y in 0..<pixels.height { for x in 0..<pixels.width {
            let dx = (Double(x) + 0.5 - 64) / 64, dy = (Double(y) + 0.5 - 12) / 12
            let falloff = max(0, 1 - dx * dx - dy * dy)
            pixels.bytes[(y * pixels.width + x) * 4 + 3] = UInt8((38 * falloff * falloff).rounded())
        } }
        return pixels.image
    }()

    static func drawContact(in target: NSRect, opacity: Double) {
        let height = max(2, target.height * 0.022)
        let ground = target.minY + target.height * (16.0 / 384)
        let rect = NSRect(x: target.midX - target.width * 0.32, y: ground - height * 0.55,
                          width: target.width * 0.64, height: height)
        contact?.draw(in: rect, from: .zero, operation: .sourceOver, fraction: opacity)
    }
}
