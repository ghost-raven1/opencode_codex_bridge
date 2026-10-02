import AppKit

@main struct CharacterViewTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        let panel = CompanionPanel(contentRect: NSRect(x: 0, y: 0, width: 168, height: 330),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        precondition(panel.canBecomeKey && !panel.canBecomeMain, "Speech text cannot receive Cmd+C")
        let view = CharacterView(frame: panel.contentView!.bounds)
        panel.contentView = view
        let working = Character(id: "agent", column: 1, label: "CODE", state: "working")
        let thinking = Character(id: "agent", column: 1, label: "CODE", state: "thinking")
        view.snapshotTime = 1000; view.update(working)
        view.snapshotTime = 1003; view.remove(working.id)
        view.snapshotTime = 1003.1; view.update(thinking)
        view.snapshotTime = 1005; view.tick()
        precondition(view.characters.count == 1, "New work did not cancel departure")
        view.snapshotTime = 1010; view.replace([thinking], animated: false)
        let badge = view.subviews.compactMap { $0 as? CharacterBadgeView }.first!
        for index in 0..<1000 {
            view.snapshotTime = 1010 + Double(index) / 24
            let character = Character(id: "agent", column: index % 4, label: "CODEX · REVIEW", state: ["working", "thinking", "success", "waiting", "error"][index % 5])
            view.update(character); view.tick()
            let badges = view.subviews.compactMap { $0 as? CharacterBadgeView }
            precondition(badges.count == 1 && badges[0] === badge, "Badge controls are recreated on every frame")
        }
        view.remove("agent", immediately: true)
        precondition(view.subviews.compactMap { $0 as? CharacterBadgeView }.isEmpty)
        print("PASS key-capable panel, cancelled departure, stable badge controls across 1000 updates and cleanup")
    }
}
