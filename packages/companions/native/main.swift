import AppKit
import AVFoundation

func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

/// Native speech callbacks are the only source of the talking state; queue is shared by all roles.
@MainActor final class CompanionApp: NSObject, NSApplicationDelegate, @preconcurrency AVSpeechSynthesizerDelegate {
    let view = CharacterView(frame: NSRect(x: 0, y: 0, width: 672, height: 330))
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 672, height: 330),
        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    let speech = AVSpeechSynthesizer()
    var voice: AVSpeechSynthesisVoice?
    var activeUtterance: AVSpeechUtterance?
    var activeCharacter: String?
    var queue: [(String, String)] = []
    var timer: Timer?
    var item: NSStatusItem?
    var muted = false
    var maxVisible = 4
    var scale: CGFloat = 1

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let path = argument("--atlas"), let atlas = NSImage(contentsOfFile: path) else {
            fputs("Missing character atlas\n", stderr); NSApp.terminate(nil); return
        }
        view.atlas = atlas
        if let raw = argument("--config"), let data = raw.data(using: .utf8),
           let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            maxVisible = min(max(config["maxVisible"] as? Int ?? 4, 1), 4)
            scale = min(max(config["scale"] as? Double ?? 1, 0.5), 2)
            let language = config["language"] as? String ?? "ru-RU"
            voice = AVSpeechSynthesisVoice(language: language)
        }
        speech.delegate = self
        panel.backgroundColor = .clear; panel.isOpaque = false; panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = true
        panel.contentView = view
        panel.setFrameOrigin(NSPoint(x: 20, y: 40))
        let menu = NSMenu()
        menu.addItem(withTitle: "Выключить / включить голос", action: #selector(toggleMute), keyEquivalent: "")
        menu.addItem(withTitle: "Закрыть персонажей", action: #selector(quit), keyEquivalent: "q")
        for entry in menu.items { entry.target = self }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item?.button?.title = "✦"; item?.menu = menu
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 24, repeats: true) { [weak self] _ in self?.view.needsDisplay = true }
        if CommandLine.arguments.contains("--preview") || argument("--snapshot") != nil {
            view.characters = ["LEAD", "CODE", "RESEARCH", "REVIEW"].enumerated().map {
                Character(id: "preview-\($0.offset)", column: $0.offset, label: $0.element, state: "idle")
            }
            resize(); panel.orderFrontRegardless()
        }
        if let output = argument("--snapshot") {
            view.snapshot(output); NSApp.terminate(nil); return
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while let line = readLine() {
                guard line.utf8.count <= 128_000, let data = line.data(using: .utf8),
                      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async { self?.receive(value) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    func resize() {
        let size = NSSize(width: CGFloat(max(view.characters.count, 1)) * 168 * scale, height: 330 * scale)
        panel.setContentSize(size); view.setBoundsSize(NSSize(width: CGFloat(max(view.characters.count, 1)) * 168, height: 330))
    }

    func receive(_ value: [String: Any]) {
        guard let type = value["type"] as? String, let id = value["characterId"] as? String else { return }
        switch type {
        case "state":
            let appearance = value["appearance"] as? [String: Any] ?? [:]
            let character = Character(id: id, column: min(max(appearance["column"] as? Int ?? 0, 0), 3),
                label: appearance["label"] as? String ?? "LEAD", state: value["state"] as? String ?? "idle")
            if let index = view.characters.firstIndex(where: { $0.id == id }) { view.characters[index] = character }
            else {
                if view.characters.count >= maxVisible { view.characters.removeFirst() }
                view.characters.append(character)
            }
            resize(); panel.orderFrontRegardless()
        case "speak":
            if !muted, let text = value["text"] as? String, !text.isEmpty, queue.count < 16 {
                queue.append((id, String(text.prefix(8000)))); speakNext()
            }
        case "stop":
            queue.removeAll { $0.0 == id }
            if activeCharacter == id { activeUtterance = nil; speech.stopSpeaking(at: .immediate); resetSpeaker(); speakNext() }
        case "remove":
            queue.removeAll { $0.0 == id }
            if activeCharacter == id { activeUtterance = nil; speech.stopSpeaking(at: .immediate); resetSpeaker(); speakNext() }
            view.characters.removeAll { $0.id == id }; resize()
            if view.characters.isEmpty { panel.orderOut(nil) }
        default: break
        }
        view.needsDisplay = true
    }

    func speakNext() {
        guard activeUtterance == nil, !queue.isEmpty, !muted else { return }
        let (id, text) = queue.removeFirst()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        activeUtterance = utterance; activeCharacter = id
        speech.speak(utterance)
    }
    func resetSpeaker() {
        activeUtterance = nil; activeCharacter = nil
        view.speaker = nil; view.mouthUntil = 0; view.bubble = ""
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        guard activeUtterance === utterance else { return }
        view.speaker = activeCharacter; view.bubble = utterance.speechString
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString range: NSRange, utterance: AVSpeechUtterance) {
        guard activeUtterance === utterance else { return }
        // Word-boundary approximation, not phoneme-perfect lip sync.
        view.mouthUntil = Date.timeIntervalSinceReferenceDate + min(0.24, 0.06 + Double(range.length) * 0.025)
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        guard activeUtterance === utterance else { return }
        resetSpeaker(); speakNext()
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        guard activeUtterance === utterance else { return }
        resetSpeaker(); speakNext()
    }
    @objc func toggleMute() {
        muted.toggle()
        if muted { queue.removeAll(); activeUtterance = nil; speech.stopSpeaking(at: .immediate); resetSpeaker() }
    }

    @objc func quit() { NSApp.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) { timer?.invalidate(); speech.stopSpeaking(at: .immediate) }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = CompanionApp()
    app.delegate = delegate
    app.run()
}
