import AppKit
import CoreImage

/// Feather only alpha boundaries once per frame/scale; fully opaque artwork stays pixel sharp.
final class SpriteCache {
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var frames: [String: NSImage] = [:]

    func frame(_ image: NSImage, column: Int, row: Int, rows: Int, radius: CGFloat,
               face: NSImage? = nil, faceColumn: Int = 0, faceRows: [Int] = []) -> NSImage? {
        let radius = (min(4, max(0.5, radius)) * 4).rounded() / 4
        let key = "\(ObjectIdentifier(image))-\(column)-\(row)-\(rows)-\(radius)-\(face.map { String(describing: ObjectIdentifier($0)) } ?? "")-\(faceColumn)-\(faceRows)"
        if let cached = frames[key] { return cached }
        guard let crop = crop(image, column: column, row: row, rows: rows) else { return nil }
        var original = CIImage(cgImage: crop)
        if let face {
            for row in faceRows where row >= 0 && row < 18 {
                if let patch = self.crop(face, column: faceColumn, row: row, rows: 18) {
                    original = CIImage(cgImage: patch).composited(over: original)
                }
            }
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
        if frames.count >= 512 { frames.removeAll(keepingCapacity: true) }
        frames[key] = rendered
        return rendered
    }

    private func crop(_ image: NSImage, column: Int, row: Int, rows: Int) -> CGImage? {
        var rect = NSRect(origin: .zero, size: image.size)
        guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return nil }
        let width = cg.width / 4, height = cg.height / rows
        return cg.cropping(to: CGRect(x: column * width, y: row * height, width: width, height: height))
    }
}
