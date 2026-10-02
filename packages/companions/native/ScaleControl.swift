import AppKit

/// Keep one proportional scale for artwork, badges and text, fitting the whole group on screen.
enum CompanionScale {
    static func bounded(_ value: Double, fallback: Double = 1) -> Double {
        guard value.isFinite else { return fallback }
        return min(2, max(0.5, value))
    }

    static func fitted(_ requested: Double, base: NSSize, visible: NSRect?) -> Double {
        let requested = bounded(requested)
        guard base.width > 0, base.height > 0, let visible, visible.width > 0, visible.height > 0 else { return requested }
        return min(requested, visible.width / base.width, visible.height / base.height)
    }
}

/// An explicit menu choice overrides configuration until the user resets it.
@MainActor final class ScaleControl: NSObject {
    static let preference = "companions.scale"
    let menuItem = NSMenuItem(title: "Размер компаньонов", action: nil, keyEquivalent: "")
    private let defaults: UserDefaults
    private let configured: Double
    private var choices: [NSMenuItem] = []
    private(set) var value: Double
    private(set) var effective: Double
    var onChange: (() -> Void)?

    init(configured: Double, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.configured = CompanionScale.bounded(configured)
        let saved = defaults.object(forKey: Self.preference) as? Double
        value = saved.flatMap { $0.isFinite ? CompanionScale.bounded($0) : nil } ?? self.configured
        effective = value
        super.init()
        let menu = NSMenu(); menu.autoenablesItems = false
        for percent in stride(from: 50, through: 200, by: 25) {
            let item = menu.addItem(withTitle: "\(percent)%", action: #selector(selectScale(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = Double(percent) / 100
            choices.append(item)
        }
        menu.addItem(.separator())
        let reset = menu.addItem(withTitle: "Сбросить размер к настройке проекта", action: #selector(reset), keyEquivalent: "")
        reset.target = self; menuItem.submenu = menu
        updateMenu()
    }

    func set(_ value: Double) {
        guard value.isFinite else { return }
        self.value = CompanionScale.bounded(value)
        defaults.set(self.value, forKey: Self.preference)
        updateMenu(); onChange?()
    }

    @objc func reset() {
        defaults.removeObject(forKey: Self.preference); value = configured
        updateMenu(); onChange?()
    }

    @objc private func selectScale(_ sender: NSMenuItem) {
        if let value = sender.representedObject as? Double { set(value) }
    }

    /// Preserve the group's lower-left position; WindowState only shifts it if an edge leaves the screen.
    func apply(panel: NSPanel, view: NSView, base: NSSize, visible: NSRect?) {
        let origin = panel.frame.origin
        effective = CompanionScale.fitted(value, base: base, visible: visible)
        let size = NSSize(width: base.width * effective, height: base.height * effective)
        panel.setContentSize(size)
        panel.setFrameOrigin(origin)
        // AppKit rounds window dimensions to points; keep the artwork's content transform uniform.
        view.setFrameSize(size)
        view.setBoundsSize(base)
        view.needsLayout = true; view.layoutSubtreeIfNeeded()
        view.needsDisplay = true
        updateMenu()
    }

    private func updateMenu() {
        let percent = Int((value * 100).rounded()), fitted = Int((effective * 100).rounded())
        menuItem.title = effective + 0.001 < value ? "Размер: \(percent)% (на экране \(fitted)%)" : "Размер компаньонов: \(percent)%"
        for item in choices { item.state = abs((item.representedObject as? Double ?? 0) - value) < 0.001 ? .on : .off }
    }
}
