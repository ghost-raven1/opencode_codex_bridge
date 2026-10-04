import AppKit

struct MusicPose {
    var x: CGFloat = 0, y: CGFloat = 0, angle: CGFloat = 0
    var headX: CGFloat = 0, headY: CGFloat = 0, headAngle: CGFloat = 0
    var arm: Double = 0, hair: Double = 0, strength: Double = 0
    func scaled(_ weight: Double) -> MusicPose {
        MusicPose(x: x * weight, y: y * weight, angle: angle * weight,
                  headX: headX * weight, headY: headY * weight, headAngle: headAngle * weight,
                  arm: arm * weight, hair: hair * weight, strength: strength * weight)
    }
}

/// Seven styles share the measured beat phase; no beat means no dance.
enum MusicMotion {
    static func pose(beat: MusicBeatState?, time: Double, column: Int, rig: String?, reduced: Bool) -> MusicPose {
        guard !reduced, let beat, beat.period > 0 else { return MusicPose() }
        let strength = beat.strength(at: time)
        guard strength > 0 else { return MusicPose() }
        let position = max(0, (time - beat.anchor) / beat.period)
        let phase = position - floor(position), sequence = beat.sequence + Int(floor(position))
        let side = sequence % 2 == 0 ? 1.0 : -1.0
        let bounce = pow(max(0, sin(phase * .pi)), 1.5), hit = exp(-phase * 10)
        let sway = side * sin(phase * .pi), double = sin(phase * 2 * .pi)
        var pose: MusicPose
        switch rig ?? String(column) {
        case "designer": pose = MusicPose(x: sway * 4, y: bounce * 4, angle: sway * 6, headX: -sway, headY: -hit, headAngle: -sway * 2.5, arm: double, hair: -sway, strength: strength)
        case "devops": pose = MusicPose(x: sway * 2, y: bounce * 7, angle: side * hit * 4, headY: -hit * 2, headAngle: -side * hit, arm: hit * 0.9, hair: double * 0.5, strength: strength)
        case "tester": pose = MusicPose(x: double * 2, y: abs(double) * 4, angle: sway * 3, headX: -double, headY: -hit * 2, headAngle: -sway * 2, arm: double * 0.9, hair: double, strength: strength)
        case "code", "1": pose = MusicPose(x: sway * 3, y: bounce * 6, angle: sway * 5, headY: -hit * 2.5, headAngle: -side * hit * 3, arm: hit, hair: -sway, strength: strength)
        case "research", "2": pose = MusicPose(x: sway * 5, y: bounce * 2, angle: -sway * 3, headX: sway, headY: bounce, headAngle: sway * 2, arm: sway * 0.5, hair: sway, strength: strength)
        case "review", "3": pose = MusicPose(x: side * hit * 2, y: bounce * 4, angle: side * hit * 6, headY: -hit * 2, headAngle: -side * hit * 2, arm: -hit, hair: double * 0.6, strength: strength)
        default: pose = MusicPose(x: sway * 3, y: bounce * 3, angle: -sway * 3.5, headX: -sway, headY: -hit, headAngle: sway * 1.5, arm: sway * 0.7, hair: -sway * 0.5, strength: strength)
        }
        pose.x *= strength; pose.y *= strength; pose.angle *= strength
        pose.headX *= strength; pose.headY *= strength; pose.headAngle *= strength
        pose.arm *= strength; pose.hair *= strength
        return pose
    }

    static func apply(_ pose: MusicPose, target: NSRect) {
        let transform = NSAffineTransform(), factor = target.width / 256
        let pivot = NSPoint(x: target.midX, y: target.minY + 16 * target.height / 384)
        transform.translateX(by: pivot.x + pose.x * factor, yBy: pivot.y + pose.y * factor)
        transform.rotate(byDegrees: pose.angle); transform.translateX(by: -pivot.x, yBy: -pivot.y); transform.concat()
    }
}
