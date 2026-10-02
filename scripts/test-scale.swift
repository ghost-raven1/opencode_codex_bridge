import AppKit

@main struct ScaleTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        let suite = "dev.codexbridge.scale-tests.\(UUID())", defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        precondition(CompanionScale.bounded(.nan) == 1)
        precondition(CompanionScale.bounded(0.1) == 0.5 && CompanionScale.bounded(9) == 2)
        precondition(CompanionScale.fitted(2, base: NSSize(width: 672, height: 441), visible: NSRect(x: 0, y: 0, width: 1000, height: 700)) == 1000.0 / 672)
        let control = ScaleControl(configured: 1.25, defaults: defaults)
        precondition(control.value == 1.25 && defaults.object(forKey: ScaleControl.preference) == nil)
        var changes = 0; control.onChange = { changes += 1 }
        control.set(1.75)
        precondition(control.value == 1.75 && changes == 1)
        precondition(ScaleControl(configured: 0.5, defaults: defaults).value == 1.75, "Explicit choice was not restored")
        control.set(.nan); precondition(control.value == 1.75 && changes == 1)
        control.reset()
        precondition(control.value == 1.25 && defaults.object(forKey: ScaleControl.preference) == nil)
        precondition(ScaleControl(configured: 0.75, defaults: defaults).value == 0.75, "Reset should restore configuration precedence")
        let panel = NSPanel(contentRect: NSRect(x: 40, y: 50, width: 168, height: 330),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 168, height: 330))
        let body = NSView(frame: NSRect(x: 20, y: 36, width: 100, height: 220))
        let face = NSView(frame: NSRect(x: 40, y: 220, width: 30, height: 20))
        let bubble = NSView(frame: NSRect(x: 10, y: 261, width: 148, height: 60))
        view.addSubview(body); view.addSubview(face); view.addSubview(bubble); panel.contentView = view
        let base = NSSize(width: 168, height: 330), visible = NSRect(x: 0, y: 0, width: 2000, height: 1200)
        for scale in [0.5, 0.75, 1.0, 1.5, 2.0] {
            control.set(scale); control.apply(panel: panel, view: view, base: base, visible: visible)
            precondition(panel.frame.origin == NSPoint(x: 40, y: 50), "Resizing drifted the group's position")
            precondition(abs(view.frame.width / view.bounds.width - scale) < 0.001)
            precondition(abs(view.frame.height / view.bounds.height - scale) < 0.001, "Non-proportional height: scale \(scale), panel \(panel.frame), view \(view.frame), bounds \(view.bounds)")
            for layer in [body, face, bubble] {
                let physical = layer.convert(layer.bounds, to: nil)
                precondition(abs(physical.width / layer.bounds.width - scale) < 0.001)
                precondition(abs(physical.height / layer.bounds.height - scale) < 0.001)
            }
            precondition(!panel.isVisible, "Changing scale must not reveal a hidden or empty panel")
        }
        control.set(2)
        control.apply(panel: panel, view: view, base: NSSize(width: 672, height: 441), visible: NSRect(x: 0, y: 0, width: 1000, height: 700))
        precondition(panel.frame.width <= 1000 && panel.frame.height <= 700)
        precondition(abs(view.frame.width / view.frame.height - 672.0 / 441) < 0.001)
        precondition(control.value == 2 && control.effective < 2, "Fitting must retain the user's requested size")
        precondition(control.menuItem.title.contains("на экране"))
        precondition(control.menuItem.submenu!.items.filter { $0.representedObject != nil }.count == 7)
        print("PASS proportional body/face/bubble scaling 50–200%, stable position, screen fit, persistence/reset and hidden-panel behavior")
    }
}
