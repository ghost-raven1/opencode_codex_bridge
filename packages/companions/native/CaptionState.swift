import Foundation

/// Public captions belong to tasks, independently of synthesis and audio callbacks.
struct CaptionState {
    private var captions: [String: String] = [:]
    private var order: [String] = []
    func contains(_ id: String) -> Bool { captions[id] != nil }
    mutating func update(_ id: String, text: String) {
        order.removeAll { $0 == id }
        if text.isEmpty { captions[id] = nil }
        else { captions[id] = text; order.append(id) }
        if order.count > 128 { captions[order.removeFirst()] = nil }
    }
    func text(visible: Set<String>, preferred: String? = nil) -> String {
        if let id = preferred, visible.contains(id), let text = captions[id] { return text }
        guard let id = order.last(where: { visible.contains($0) }) else { return "" }
        return captions[id] ?? ""
    }
}
