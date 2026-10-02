import AppKit

/// Continuous offsets in source pixels: artwork stays fixed while its layers move independently.
struct LayerPose {
    var bodyScaleY: CGFloat = 1
    var headX: CGFloat = 0
    var headY: CGFloat = 0
    var headAngle: CGFloat = 0
}

enum LayeredMotion {
    // atlas.json: top-left (128, 120), converted to AppKit bottom-left coordinates.
    static let neck = NSPoint(x: 128, y: 264)

    static func pose(state: String, time: Double, gestureElapsed: Double?,
                     speaking: Bool, reduced: Bool, seed: Int) -> LayerPose {
        guard !reduced else { return LayerPose() }
        let phase = time + Double(seed) * 1.7
        let breath = sin(phase * 1.35)
        var pose = LayerPose(bodyScaleY: 1 + breath * 0.004,
                             headX: sin(phase * 0.55) * 0.55,
                             headY: breath * 0.65,
                             headAngle: sin(phase * 0.65) * 0.7)
        if speaking { pose.headAngle += sin(phase * 2.1) * 0.45 }
        if let elapsed = gestureElapsed, elapsed >= 0, elapsed < 3.6 {
            let envelope = pow(sin(elapsed / 3.6 * .pi), 2)
            switch state {
            case "working": pose.headY -= envelope * 1.8; pose.headAngle -= envelope
            case "thinking": pose.headAngle += envelope * 2.4
            case "success": pose.headY += sin(elapsed * 3.4) * envelope * 1.2
            case "waiting", "error": pose.headAngle -= envelope * 1.6
            default: pose.headAngle += envelope * 1.3
            }
        }
        return pose
    }
}
