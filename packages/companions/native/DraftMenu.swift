import AppKit

/// Metadata-only menu; full text crosses IPC only after an explicit view or copy action.
@MainActor final class DraftMenu: NSObject {
    let menu = NSMenu()
    func update(_ value: [String: Any]) {
        menu.removeAllItems()
        let drafts = value["items"] as? [[String: Any]] ?? []
        let project = (value["project"] as? String ?? "").split(separator: "/").last.map(String.init) ?? "Проект"
        menu.addItem(withTitle: project, action: nil, keyEquivalent: "").isEnabled = false
        if drafts.isEmpty { menu.addItem(withTitle: "Черновиков пока нет", action: nil, keyEquivalent: "").isEnabled = false }
        for draft in drafts.reversed() {
            guard let id = draft["id"] as? String else { continue }
            let preview = (draft["preview"] as? String ?? "").replacingOccurrences(of: "\n", with: " ")
            let item = menu.addItem(withTitle: String(preview.prefix(65)), action: nil, keyEquivalent: "")
            let submenu = NSMenu()
            for (title, action) in [("Просмотреть", "view"), ("Повторить вставку в CLI", "insert"), ("Скопировать", "copy")] {
                let entry = submenu.addItem(withTitle: title, action: #selector(request(_:)), keyEquivalent: "")
                entry.target = self; entry.representedObject = ["id": id, "action": action]
            }
            item.submenu = submenu
        }
        if !drafts.isEmpty {
            menu.addItem(.separator())
            let clear = menu.addItem(withTitle: "Очистить историю этого проекта", action: #selector(request(_:)), keyEquivalent: "")
            clear.target = self; clear.representedObject = ["action": "clear"]
        }
    }
    @objc private func request(_ sender: NSMenuItem) {
        guard var event = sender.representedObject as? [String: String] else { return }
        event["type"] = "draft-action"; emit(event)
    }
    func receiveText(_ value: [String: Any]) {
        guard let text = value["text"] as? String else { return }
        if value["action"] as? String == "copy" {
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        } else {
            let alert = NSAlert(); alert.messageText = "Черновик диктовки"
            let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 500, height: 260))
            scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
            let contents = NSTextView(frame: scroll.bounds)
            contents.isEditable = false; contents.isSelectable = true; contents.string = text
            contents.font = .systemFont(ofSize: 14); contents.textContainerInset = NSSize(width: 8, height: 8)
            contents.isVerticallyResizable = true; contents.autoresizingMask = [.width]
            contents.textContainer?.widthTracksTextView = true
            scroll.documentView = contents; alert.accessoryView = scroll
            alert.addButton(withTitle: "Закрыть"); alert.addButton(withTitle: "Скопировать")
            if alert.runModal() == .alertSecondButtonReturn {
                NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
            }
        }
    }
}
