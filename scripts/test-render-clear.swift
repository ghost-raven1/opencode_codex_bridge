import AppKit

/// A transparent view must replace its previous pixels before drawing the next moving frame.
@main struct RenderClearTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        func bitmap(_ width: Int, _ height: Int) -> NSBitmapImageRep {
            let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                bytesPerRow: 0, bitsPerPixel: 0)!
            image.bitmapData!.initialize(repeating: 0, count: image.bytesPerRow * image.pixelsHigh)
            return image
        }
        // All roles share identical art so changed pixels only come from a moving/fading frame.
        let source = bitmap(16, 16)
        for offset in stride(from: 0, to: source.bytesPerRow * source.pixelsHigh, by: 4) {
            source.bitmapData![offset] = 255; source.bitmapData![offset + 2] = 255; source.bitmapData![offset + 3] = 255
        }
        let atlas = NSImage(data: source.representation(using: .png, properties: [:])!)!
        let view = CharacterView(frame: NSRect(x: 0, y: 0, width: 168, height: 330)); view.atlas = atlas
        let first = Character(id: "a", column: 0, label: "A", state: "working")

        func draw(_ context: NSGraphicsContext) {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = context
            view.draw(view.bounds)
            NSGraphicsContext.restoreGraphicsState()
        }
        let reused = bitmap(168, 330), fresh = bitmap(168, 330)
        let reusedContext = NSGraphicsContext(bitmapImageRep: reused)!, freshContext = NSGraphicsContext(bitmapImageRep: fresh)!
        view.snapshotTime = 1000; view.replace([first], animated: true)
        view.snapshotTime = 1000.25; draw(reusedContext)
        view.snapshotTime = 1000.65; draw(reusedContext); draw(freshContext)
        var trails = 0
        for offset in stride(from: 0, to: fresh.bytesPerRow * fresh.pixelsHigh, by: 4) {
            if fresh.bitmapData![offset + 3] == 0 && reused.bitmapData![offset + 3] > 0 { trails += 1 }
        }
        FileHandle.standardError.write(Data("Pixels left outside the current frame: \(trails)\n".utf8))
        precondition(trails == 0, "Transparent redraw kept the previous frame, leaving duplicated contours")
        precondition(Data(bytes: reused.bitmapData!, count: reused.bytesPerRow * reused.pixelsHigh) ==
            Data(bytes: fresh.bitmapData!, count: fresh.bytesPerRow * fresh.pixelsHigh), "Same frame depends on previous animation pixels")
        view.remove("a", immediately: true); draw(reusedContext)
        precondition((0..<reused.bytesPerRow * reused.pixelsHigh).allSatisfy { reused.bitmapData![$0] == 0 },
            "Removed character leaves pixels in the transparent view")
        print("PASS transparent redraw matches a fresh frame, removes old contours and clears departed artwork")
    }
}
