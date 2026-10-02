import AppKit

@main struct CharacterViewTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        let panel = CompanionPanel(contentRect: NSRect(x: 0, y: 0, width: 168, height: 330),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        precondition(panel.canBecomeKey && !panel.canBecomeMain, "Speech text cannot receive Cmd+C")
        let view = CharacterView(frame: panel.contentView!.bounds)
        panel.contentView = view
        let visible = panel.screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        panel.setFrameOrigin(NSPoint(x: visible.minX + 40, y: visible.minY + 40))
        var requested: Double?
        view.onResize = { requested = $0 }
        func mouse(_ type: NSEvent.EventType, _ point: NSPoint) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: 0,
                              windowNumber: panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        let handle = NSPoint(x: 160, y: 6), origin = panel.frame.origin
        view.mouseDown(with: mouse(.leftMouseDown, handle))
        view.mouseDragged(with: mouse(.leftMouseDragged, NSPoint(x: handle.x + 84, y: handle.y)))
        precondition(requested == 1.5, "Corner drag did not resize proportionally")
        precondition(panel.frame.origin == origin, "Corner resize was mistaken for moving the group")
        view.mouseUp(with: mouse(.leftMouseUp, handle)); requested = nil
        view.mouseDown(with: mouse(.leftMouseDown, handle))
        view.mouseDragged(with: mouse(.leftMouseDragged, NSPoint(x: handle.x, y: handle.y - 165)))
        precondition(requested == 1.5, "Vertical corner drag ignored window height")
        view.mouseUp(with: mouse(.leftMouseUp, handle)); requested = nil
        view.mouseDragged(with: mouse(.leftMouseDragged, NSPoint(x: 300, y: 6)))
        precondition(requested == nil, "Released resize kept handling stale drag events")
        for scale in [0.5, 2.0] {
            panel.setContentSize(NSSize(width: 168 * scale, height: 330 * scale))
            view.setFrameSize(panel.contentView!.frame.size); view.setBoundsSize(NSSize(width: 168, height: 330))
            let physical = view.convert(handle, to: nil)
            view.mouseDown(with: mouse(.leftMouseDown, physical))
            view.mouseDragged(with: mouse(.leftMouseDragged, NSPoint(x: physical.x + 42 * scale, y: physical.y)))
            precondition(abs(requested! - scale * 1.25) < 0.001, "Scaled window handle missed its hit area")
            view.mouseUp(with: mouse(.leftMouseUp, physical))
        }
        panel.setContentSize(NSSize(width: 168, height: 330)); view.setFrameSize(panel.contentView!.frame.size)
        view.setBoundsSize(NSSize(width: 168, height: 330))
        view.musicBeat = MusicBeatState(anchor: 1000, period: 0.5, sequence: 10, confidence: 1,
                                       audibleAt: 1000, allowance: 1, measuredAt: 1000)
        view.snapshotTime = 1000; view.tick()
        precondition(view.characters.isEmpty, "Music created a phantom character")
        let working = Character(id: "agent", column: 1, label: "CODE", state: "working")
        let thinking = Character(id: "agent", column: 1, label: "CODE", state: "thinking")
        view.snapshotTime = 1000; view.update(working)
        view.snapshotTime = 1003; view.remove(working.id)
        view.snapshotTime = 1003.1; view.update(thinking)
        view.snapshotTime = 1005; view.tick()
        precondition(view.characters.count == 1, "New work did not cancel departure")
        view.snapshotTime = 1010; view.replace([thinking], animated: false)
        let badge = view.subviews.compactMap { $0 as? CharacterBadgeView }.first!
        for scale in [0.5, 1.0, 2.0] {
            for state in ["working", "success", "error", "waiting"] {
                badge.frame = NSRect(x: 0, y: 0, width: 148 * scale, height: 28 * scale)
                badge.setBoundsSize(NSSize(width: 148, height: 28))
                badge.update(Character(id: "named", column: 0, label: "CODEX · RESEARCH", state: state, name: "Каэми"), color: .systemGreen)
                badge.layoutSubtreeIfNeeded()
                let fields = badge.subviews.compactMap { $0 as? NSTextField }
                let name = fields.first { $0.stringValue == "Каэми" }!
                let role = fields.first { $0.stringValue == "RESEARCH" }!
                precondition(name.frame.maxX <= role.frame.minX, "Name and role overlap")
                precondition(name.intrinsicContentSize.width + 6 <= name.frame.width, "Generated name is truncated")
                precondition(role.intrinsicContentSize.width + 6 <= role.frame.width, "Role is truncated")
                precondition(badge.bounds.contains(name.frame) && badge.bounds.contains(role.frame), "Named badge exceeds its original height")
                precondition(badge.toolTip == "Каэми · CODEX · RESEARCH", "Full identity is missing from tooltip")
            }
        }
        badge.frame = NSRect(x: 0, y: 0, width: 148, height: 28); badge.setBoundsSize(badge.frame.size)
        for index in 0..<1000 {
            view.snapshotTime = 1010 + Double(index) / 24
            let character = Character(id: "agent", column: index % 4, label: "CODEX · REVIEW", state: ["working", "thinking", "success", "waiting", "error"][index % 5])
            view.update(character); view.tick()
            let badges = view.subviews.compactMap { $0 as? CharacterBadgeView }
            precondition(badges.count == 1 && badges[0] === badge, "Badge controls are recreated on every frame")
        }
        view.remove("agent", immediately: true)
        precondition(view.subviews.compactMap { $0 as? CharacterBadgeView }.isEmpty)
        view.snapshotTime = 2000; view.update(working); view.remove(working.id)
        view.musicBeat = MusicBeatState(anchor: 2001, period: 0.5, sequence: 20, confidence: 1,
                                       audibleAt: 2001, allowance: 1, measuredAt: 2001)
        view.snapshotTime = 2001; view.tick()
        precondition(view.characters.isEmpty, "Music retained a finished character beyond its departure")
        print("PASS key-capable panel, cancelled departure, stable badge controls across 1000 updates, music cannot create/resurrect characters and cleanup")
    }
}
