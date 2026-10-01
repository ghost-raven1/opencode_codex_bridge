import AppKit

/// Text controls can receive Cmd+C without making the companion the main application window.
final class CompanionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Persist the group's position and visibility independently of session updates or speech.
@MainActor final class WindowState: NSObject, NSWindowDelegate {
    let panel: NSPanel
    private let defaults = UserDefaults.standard
    private(set) var hidden: Bool
    var onChange: (() -> Void)?

    init(panel: NSPanel) {
        self.panel = panel
        hidden = UserDefaults.standard.bool(forKey: "companions.hidden")
        super.init()
        let saved = defaults.array(forKey: "companions.position") as? [Double]
        if let saved, saved.count == 2, saved.allSatisfy({ $0.isFinite }) {
            panel.setFrameOrigin(NSPoint(x: saved[0], y: saved[1]))
        } else { resetPosition() }
        panel.delegate = self
        fitToScreen()
        NotificationCenter.default.addObserver(self, selector: #selector(screenChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }

    func setHidden(_ value: Bool) {
        hidden = value; defaults.set(value, forKey: "companions.hidden")
        onChange?()
    }

    func present(hasContent: Bool) {
        if hidden || !hasContent { panel.orderOut(nil) }
        else { fitToScreen(); panel.orderFrontRegardless() }
    }

    func resetPosition() {
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.minX + 20, y: screen.visibleFrame.minY + 20))
        fitToScreen()
    }

    /// Keep the group reachable after a monitor disconnect or a change in the visible team size.
    func fitToScreen() {
        let frame = panel.frame
        guard let screen = NSScreen.screens.min(by: { distance(frame, to: $0.visibleFrame) < distance(frame, to: $1.visibleFrame) }) else { return }
        let visible = screen.visibleFrame
        let origin = NSPoint(
            x: min(max(frame.minX, visible.minX), max(visible.minX, visible.maxX - frame.width)),
            y: min(max(frame.minY, visible.minY), max(visible.minY, visible.maxY - frame.height)))
        if origin != frame.origin { panel.setFrameOrigin(origin) }
    }

    private func distance(_ frame: NSRect, to screen: NSRect) -> CGFloat {
        let center = NSPoint(x: frame.midX, y: frame.midY)
        let x = max(screen.minX - center.x, 0, center.x - screen.maxX)
        let y = max(screen.minY - center.y, 0, center.y - screen.maxY)
        return x * x + y * y
    }

    func windowDidMove(_ notification: Notification) {
        defaults.set([Double(panel.frame.minX), Double(panel.frame.minY)], forKey: "companions.position")
        onChange?()
    }

    @objc private func screenChanged() { fitToScreen() }
}
