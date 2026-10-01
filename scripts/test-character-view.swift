import AppKit

@main struct CharacterViewTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        let panel = CompanionPanel(contentRect: NSRect(x: 0, y: 0, width: 168, height: 330),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        precondition(panel.canBecomeKey && !panel.canBecomeMain, "Speech text cannot receive Cmd+C")
        let view = CharacterView(frame: panel.contentView!.bounds)
        panel.contentView = view
        let base = NSImage(size: NSSize(width: 1024, height: 1536))
        let thought = NSImage(size: NSSize(width: 1024, height: 3840))
        view.clips.images["thinking.png"] = thought
        view.clips.clips["thinking"] = AnimationClip(atlas: "thinking.png", frames: Array(0..<10), durationMs: 1600)
        let working = Character(id: "agent", column: 1, label: "CODE", state: "working")
        let thinking = Character(id: "agent", column: 1, label: "CODE", state: "thinking")
        view.snapshotTime = 1000; view.update(working)
        view.snapshotTime = 1003; view.remove(working.id)
        view.snapshotTime = 1003.1; view.update(thinking)
        if !view.reduced {
            let returned = view.animationFrame(thinking, time: 1003.8, speaking: false, blink: false,
                motion: nil, progress: 1, base: base)
            precondition(returned.0 === thought && returned.1 == 0, "Return during departure skipped the new state clip")
        }
        view.snapshotTime = 1010; view.replace([thinking], animated: false)
        if !view.reduced {
            let snapshot = view.animationFrame(thinking, time: 1010, speaking: false, blink: false,
                motion: nil, progress: 1, base: base)
            precondition(snapshot.0 === thought && snapshot.1 == 0, "Unanimated snapshot did not show the requested state")
        }
        print("PASS key-capable companion panel, state clip after cancelled departure, immediate state snapshots")
    }
}
