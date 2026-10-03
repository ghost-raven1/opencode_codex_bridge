import AppKit

@main struct SpriteDepthTests {
    static func image(_ bytes: [UInt8], width: Int, height: Int) -> NSImage {
        let provider = CGDataProvider(data: Data(bytes) as CFData)!
        let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
        return NSImage(cgImage: image, size: NSSize(width: width, height: height))
    }
    static func pixels(_ image: NSImage) -> [UInt8] {
        var rect = NSRect(origin: .zero, size: image.size)
        let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil)!
        return Array(cg.dataProvider!.data! as Data)
    }
    static func main() {
        var body = Array(repeating: UInt8(0), count: 32 * 32 * 4), head = body
        for y in 6..<29 { for x in 4..<27 {
            let offset = (y * 32 + x) * 4
            let alpha: UInt8 = x == 4 ? 128 : 255
            body[offset] = alpha == 255 ? 180 : 90
            body[offset + 1] = body[offset]; body[offset + 2] = body[offset]; body[offset + 3] = alpha
        } }
        for y in 3..<12 { for x in 9..<20 { head[(y * 32 + x) * 4 + 3] = 255 } }
        let source = image(body, width: 32, height: 32), occluder = image(head, width: 32, height: 32)
        let shaded = pixels(SpriteDepth.body(source, under: [occluder]))
        var changed = 0
        for offset in stride(from: 0, to: body.count, by: 4) {
            precondition(shaded[offset + 3] == body[offset + 3], "Cast shadow changed the body's alpha boundary")
            for channel in 0..<3 {
                precondition(shaded[offset + channel] <= body[offset + channel], "Shadow introduced a bright halo")
                precondition(Double(shaded[offset + channel]) >= Double(body[offset + channel]) * 0.89, "Shadow is too dark for pixel artwork")
                if shaded[offset + channel] != body[offset + channel] { changed += 1 }
            }
        }
        precondition(changed > 0 && changed < 400, "Cast shadow must remain close to the layer overlap")
        let far = (25 * 32 + 20) * 4
        precondition(Array(shaded[far..<far + 4]) == Array(body[far..<far + 4]), "Opaque interior detail outside the shadow changed")
        precondition(pixels(SpriteDepth.body(source, under: [])) == body, "Missing occluder changes artwork")
        let lit = pixels(SpriteDepth.volume(source))
        var changedLighting = 0
        for offset in stride(from: 0, to: body.count, by: 4) {
            precondition(lit[offset + 3] == body[offset + 3], "Volume added a halo or removed edge pixels")
            for channel in 0..<3 {
                let value = Double(body[offset + channel]), alpha = Double(body[offset + 3])
                precondition(Double(lit[offset + channel]) >= value * 0.92 - 1, "Volume muddied pixel details")
                precondition(Double(lit[offset + channel]) <= value + (alpha - value) * 0.05 + 1, "Volume overexposed the highlight")
                precondition(lit[offset + channel] <= lit[offset + 3], "Invalid premultiplied edge")
                if lit[offset + channel] != body[offset + channel] { changedLighting += 1 }
            }
        }
        precondition(changedLighting > 400, "Volume never shaded the surface")
        let left = (20 * 32 + 6) * 4, right = (20 * 32 + 25) * 4
        precondition(lit[left] > lit[right], "Surface does not follow the top-left light")
        let contact = SpriteDepth.contact!, again = SpriteDepth.contact!
        precondition(contact === again, "Contact image is recreated per draw")
        let ground = pixels(contact)
        let alphas = stride(from: 3, to: ground.count, by: 4).map { Int(ground[$0]) }
        precondition(alphas.max()! <= 38 && alphas.max()! > 30 && alphas.first == 0 && alphas.last == 0)
        // Black shadow remains subtle on both backgrounds and vanishes continuously at its outer edge.
        for background in [255.0, 18.0] {
            for alpha in alphas {
                let composite = background * (1 - Double(alpha) / 255)
                precondition(composite >= background * 0.85 && composite <= background)
            }
        }
        print("PASS cached contact shadow, preserved sprite alpha/interior, restrained overlap shading and light/dark composition")
    }
}
