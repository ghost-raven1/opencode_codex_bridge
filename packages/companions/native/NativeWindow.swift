import AppKit

/// Window gestures share the persisted proportional scale used by the menu.
extension CompanionApp {
    func configurePanel() {
        panel.backgroundColor = .clear; panel.isOpaque = false; panel.hasShadow = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = false; panel.contentView = view
        view.toolTip = "Перетащи персонажа — переместить. Потяни нижний правый угол — изменить размер. Правый клик — скрыть."
        windowState = WindowState(panel: panel)
        windowState.onChange = { [weak self] in self?.updateMenu() }
        windowState.onScreenChange = { [weak self] in self?.resize() }
        view.onResize = { [weak self] scale in self?.scaleControl.set(scale) }
        scaleControl.onChange = { [weak self] in self?.resize(); self?.emitWindowStatus() }
        let context = NSMenu()
        context.addItem(withTitle: "Скрыть компаньонов", action: #selector(hideCompanions), keyEquivalent: "")
        context.addItem(withTitle: "Вернуть позицию на экран", action: #selector(resetPosition), keyEquivalent: "")
        for entry in context.items { entry.target = self }
        view.menu = context

    }

    func resize() {
        let count = CGFloat(max(view.characters.count, 1))
        let width = count * 168, height = view.contentHeight(width: width)
        scaleControl.apply(panel: panel, view: view, base: NSSize(width: width, height: height), visible: windowState.visibleFrame)
        windowState.fitToScreen()
    }

}
