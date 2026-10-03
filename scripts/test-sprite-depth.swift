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
        let lit = pixels(SpriteDepth.volume(source))
        var changedLighting = 0
        for offset in stride(from: 0, to: body.count, by: 4) {
            precondition(lit[offset + 3] == body[offset + 3], "Volume added a halo or removed edge pixels")
            for channel in 0..<3 {
                let value = Double(body[offset + channel]), alpha = Double(body[offset + 3])
                precondition(Double(lit[offset + channel]) >= value * 0.61 - 1, "Volume muddied pixel details")
                precondition(Double(lit[offset + channel]) <= value + (alpha - value) * 0.13 + 1, "Volume overexposed the highlight")
                precondition(lit[offset + channel] <= lit[offset + 3], "Invalid premultiplied edge")
                if lit[offset + channel] != body[offset + channel] { changedLighting += 1 }
            }
        }
        precondition(changedLighting > 400, "Volume never shaded the surface")
        let left = (20 * 32 + 6) * 4, right = (20 * 32 + 25) * 4
        precondition(lit[left] > lit[right], "Surface does not follow the top-left light")
        precondition(Int(lit[left]) - Int(lit[right]) > 20, "Surface still reads as a flat colour")
        for light in [-1, 0, 1] {
            let shifted = pixels(SpriteDepth.volume(source, light: light))
            for offset in stride(from: 0, to: body.count, by: 4) {
                precondition(shifted[offset + 3] == body[offset + 3])
                for channel in 0..<3 { precondition(shifted[offset + channel] <= shifted[offset + 3]) }
            }
        }
        precondition(pixels(SpriteDepth.volume(source, light: -1)) != pixels(SpriteDepth.volume(source, light: 1)), "Light does not react to the turn")
        let shadow = pixels(SpriteDepth.shadow(occluder)!)
        precondition(stride(from: 0, to: shadow.count, by: 4).allSatisfy { shadow[$0] == 0 && shadow[$0 + 1] == 0 && shadow[$0 + 2] == 0 })
        precondition(stride(from: 3, to: shadow.count, by: 4).map { shadow[$0] }.max() == 61)
        precondition(shadow[(2 * 32 + 10) * 4 + 3] > 0, "Cached cast shadow has no soft edge")
        let pivot = [128.0, 120.0], target = NSRect(x: 10, y: 20, width: 128, height: 192)
        let joint = NSPoint(x: 74, y: 152)
        for turn in [-0.7, 0.0, 0.7] {
            let transform = SpriteDepth.projection(pivot: pivot, target: target, turn: turn, foreground: true)
            let fixed = transform.transform(joint)
            precondition(abs(fixed.x - joint.x) < 0.001 && abs(fixed.y - joint.y) < 0.001, "Depth pulled apart a joint")
        }
        let rest = SpriteDepth.pose(time: 12, seed: 7, headX: 9, headAngle: 9, reduced: true)
        precondition(rest.turn == 0 && rest.headTurn == 0)
        let turns = Set((0..<120).map { SpriteDepth.pose(time: Double($0) / 24, seed: 7, headX: 0, headAngle: 0, reduced: false).turn })
        precondition(turns.count > 100 && turns.allSatisfy { abs($0) <= 0.65 })
        let cache = SpriteCache()
        // Use an identical colour patch: lighting before compositing would leave a visible rectangle.
        var sheet = Array(repeating: UInt8(0), count: 32 * 384 * 18 * 4)
        for y in 10..<18 { for x in 12..<20 {
            for channel in 0..<4 { sheet[(y * 32 + x) * 4 + channel] = body[(y * 32 + x) * 4 + channel] }
        } }
        let mouthSheet = image(sheet, width: 32, height: 384 * 18)
        let headSource = image(body, width: 32, height: 32)
        // Actual face sheets have a 384px frame; stretch neither the crop nor its mask.
        var canvas = Array(repeating: UInt8(0), count: 32 * 384 * 4)
        canvas.replaceSubrange(0..<body.count, with: body)
        let headCanvas = image(canvas, width: 32, height: 384)
        for light in [-1, 0, 1] {
            let plain = cache.frame(headCanvas, column: 0, row: 0, rows: 1, radius: 1, columns: 1, light: light)!
            let mouth = cache.frame(headCanvas, column: 0, row: 0, rows: 1, radius: 1, columns: 1,
                face: mouthSheet, faceRows: [0], light: light)!
            precondition(pixels(plain) == pixels(mouth), "Face patch escaped the head's surface light")
        }
        precondition(cache.frame(headSource, column: 0, row: 0, rows: 1, radius: 1, columns: 1, light: 99) ===
            cache.frame(headSource, column: 0, row: 0, rows: 1, radius: 1, columns: 1, light: 1), "Unbounded light variants bypassed the cache")
        let contact = SpriteDepth.contact!, again = SpriteDepth.contact!
        precondition(contact === again, "Contact image is recreated per draw")
        let ground = pixels(contact)
        let alphas = stride(from: 3, to: ground.count, by: 4).map { Int(ground[$0]) }
        precondition(alphas.max()! <= 52 && alphas.max()! > 45 && alphas.first == 0 && alphas.last == 0)
        // Black shadow remains subtle on both backgrounds and vanishes continuously at its outer edge.
        for background in [255.0, 18.0] {
            for alpha in alphas {
                let composite = background * (1 - Double(alpha) / 255)
                precondition(composite >= background * 0.79 && composite <= background)
            }
        }
        print("PASS rounded surface light, preserved alpha/ink, soft cached cast/contact shadows, pivot-safe perspective and Reduce Motion")
    }
}
