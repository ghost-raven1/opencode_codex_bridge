import AppKit
import CoreImage

/// Feather only alpha boundaries once per frame/scale; fully opaque artwork stays pixel sharp.
final class SpriteCache {
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var frames: [String: NSImage] = [:]
    private var access: [String: UInt64] = [:]
    private var clock: UInt64 = 0

    func frame(_ image: NSImage, column: Int, row: Int, rows: Int, radius: CGFloat, columns: Int = 4,
               face: NSImage? = nil, faceColumn: Int = 0, faceRows: [Int] = [], light: Int? = nil) -> NSImage? {
        let radius = (min(4, max(0.5, radius)) * 4).rounded() / 4
        let light = light.map { min(1, max(-1, $0)) }
        let key = "\(ObjectIdentifier(image))-\(columns)-\(column)-\(row)-\(rows)-\(radius)-\(face.map { String(describing: ObjectIdentifier($0)) } ?? "")-\(faceColumn)-\(faceRows)-\(light.map(String.init) ?? "none")"
        clock += 1
        if let cached = frames[key] { access[key] = clock; return cached }
        guard let crop = crop(image, column: column, row: row, rows: rows, columns: columns) else { return nil }
        var original = CIImage(cgImage: crop)
        if let face {
            for row in faceRows where row >= 0 && row < 18 {
                if let patch = self.crop(face, column: faceColumn, row: row, rows: 18, columns: columns) {
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
        if frames.count >= 512, let oldest = access.min(by: { $0.value < $1.value })?.key {
            frames[oldest] = nil; access[oldest] = nil
        }
        frames[key] = rendered; access[key] = clock
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
