import AppKit

@main struct CharacterViewTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        let panel = CompanionPanel(contentRect: NSRect(x: 0, y: 0, width: 168, height: 330),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        precondition(panel.canBecomeKey && !panel.canBecomeMain, "Speech text cannot receive Cmd+C")
        let view = CharacterView(frame: panel.contentView!.bounds)
        panel.contentView = view
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
