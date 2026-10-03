import AppKit
import CoreImage

/// Feather only alpha boundaries once per frame/scale; fully opaque artwork stays pixel sharp.
final class SpriteCache {
    private struct Key: Hashable {
        let source: ObjectIdentifier
        let columns: Int; let column: Int; let row: Int; let rows: Int; let radius: CGFloat
        let face: ObjectIdentifier?; let faceColumn: Int; let faceRows: [Int]; let light: Int?
    }
    private struct Entry {
        // Keep identities alive: NSImage addresses can otherwise be reused while their frames are cached.
        let source: NSImage; let face: NSImage?; let rendered: NSImage; let bytes: Int
        var accessed: UInt64
    }
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var frames: [Key: Entry] = [:]
    private var clock: UInt64 = 0
    private let byteLimit: Int
    private(set) var cachedBytes = 0
    var cachedFrameCount: Int { frames.count }

    init(byteLimit: Int = 64 * 1024 * 1024) { self.byteLimit = max(0, byteLimit) }

    /// A new artwork library releases both prepared pixels and their original image identities.
    func removeAll() {
        frames.removeAll(); cachedBytes = 0; clock = 0; context.clearCaches()
    }

    func frame(_ image: NSImage, column: Int, row: Int, rows: Int, radius: CGFloat, columns: Int = 4,
               face: NSImage? = nil, faceColumn: Int = 0, faceRows: [Int] = [], light: Int? = nil) -> NSImage? {
        let radius = (min(4, max(0.5, radius)) * 4).rounded() / 4
        let light = light.map { min(1, max(-1, $0)) }
        let faceRows = face == nil ? [] : faceRows.filter { (0..<SpriteGeometry.faceRows).contains($0) }
        let key = Key(source: ObjectIdentifier(image), columns: columns, column: column, row: row, rows: rows,
            radius: radius, face: face.map(ObjectIdentifier.init), faceColumn: faceColumn, faceRows: faceRows, light: light)
        clock &+= 1
        if var cached = frames[key] { cached.accessed = clock; frames[key] = cached; return cached.rendered }
        guard let crop = crop(image, column: column, row: row, rows: rows, columns: columns) else { return nil }
        var original = CIImage(cgImage: crop)
        if let face {
            for row in faceRows {
                if let patch = self.crop(face, column: faceColumn, row: row, rows: SpriteGeometry.faceRows, columns: columns) {
                    original = CIImage(cgImage: patch).composited(over: original)
                }
            }
        }
        // Light the composed portrait; a mouth/eyelid patch must never sit above its lighting.
        if let light, let composed = context.createCGImage(original, from: original.extent) {
            let lit = SpriteDepth.volume(NSImage(cgImage: composed, size: NSSize(width: crop.width, height: crop.height)), light: light)
            var rect = NSRect(origin: .zero, size: lit.size)
            if let pixels = lit.cgImage(forProposedRect: &rect, context: nil, hints: nil) { original = CIImage(cgImage: pixels) }
        }
        // White RGB equals alpha. Colour detail inside an opaque sprite cannot enter this mask.
        let zero = CIVector(x: 0, y: 0, z: 0, w: 0)
        let alpha = CIVector(x: 0, y: 0, z: 0, w: 1)
        let mask = original.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": alpha, "inputGVector": alpha, "inputBVector": alpha,
            "inputAVector": zero, "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 1)
        ]).applyingFilter("CIMorphologyGradient", parameters: ["inputRadius": radius + 0.5])
        let blurred = original.applyingFilter("CIGaussianBlur", parameters: ["inputRadius": radius * 0.65])
        let result = blurred.applyingFilter("CIBlendWithMask", parameters: [
            kCIInputBackgroundImageKey: original, kCIInputMaskImageKey: mask
        ]).cropped(to: original.extent)
        guard let cg = context.createCGImage(result, from: original.extent) else { return nil }
        let rendered = NSImage(cgImage: cg, size: NSSize(width: crop.width, height: crop.height))
        let bytes = cg.bytesPerRow * cg.height
        guard bytes <= byteLimit else { return rendered }
        while frames.count >= 512 || cachedBytes > byteLimit - bytes {
            guard let oldest = frames.min(by: { $0.value.accessed < $1.value.accessed })?.key,
                  let removed = frames.removeValue(forKey: oldest) else { break }
            cachedBytes -= removed.bytes
        }
        frames[key] = Entry(source: image, face: face, rendered: rendered, bytes: bytes, accessed: clock)
        cachedBytes += bytes
        return rendered
    }

    private func crop(_ image: NSImage, column: Int, row: Int, rows: Int, columns: Int) -> CGImage? {
        guard rows > 0, columns > 0, row >= 0, row < rows, column >= 0, column < columns else { return nil }
        var rect = NSRect(origin: .zero, size: image.size)
        guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return nil }
        guard cg.width % columns == 0, cg.height % rows == 0, cg.width >= columns, cg.height >= rows else { return nil }
        let width = cg.width / columns, height = cg.height / rows
        return cg.cropping(to: CGRect(x: column * width, y: row * height, width: width, height: height))
    }
}
