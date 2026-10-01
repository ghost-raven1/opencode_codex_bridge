import AppKit
import AVFoundation
import Darwin

func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

/// Stdout is a JSONL control channel; recognized speech is never written to logs.
func emit(_ event: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) else { return }
    data.append(0x0A)
    try? FileHandle.standardOutput.write(contentsOf: data)
}

var exitStatus: Int32 = 0

@MainActor final class CompanionApp: NSObject, NSApplicationDelegate {
    let view = CharacterView(frame: NSRect(x: 0, y: 0, width: 672, height: 330))
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 672, height: 330),
        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    let speech = NativeSpeech()
    let dictation = NativeDictation()
    var timer: Timer?
    var speechTestTimer: Timer?
    var item: NSStatusItem?
    var muteItem: NSMenuItem?
    var startItem: NSMenuItem?
    var finishItem: NSMenuItem?
    var cancelItem: NSMenuItem?
    var voiceItems: [NSMenuItem] = []
    var language = "ru-RU"
    var dictationEnabled = true
    var maxVisible = 4
    var scale: CGFloat = 1
    var speechTest = CommandLine.arguments.contains("--speech-test")
    var speechTestCompleted = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        var config: [String: Any] = [:]
        if let raw = argument("--config"), let data = raw.data(using: .utf8) {
            config = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        }
        maxVisible = min(max(config["maxVisible"] as? Int ?? 4, 1), 4)
        scale = min(max(config["scale"] as? Double ?? 1, 0.5), 2)
        language = config["language"] as? String ?? "ru-RU"
        dictationEnabled = config["dictation"] as? Bool ?? true
        speech.selectVoice(identifier: config["voiceIdentifier"] as? String, language: language)
        if let path = argument("--atlas") {
            view.atlas = NSImage(contentsOfFile: path)
            let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
            view.headAtlas = NSImage(contentsOf: directory.appendingPathComponent("head-atlas.png"))
            view.bodyAtlas = NSImage(contentsOf: directory.appendingPathComponent("body-atlas.png"))
            if view.atlas == nil { emit(["type": "error", "code": "atlas", "message": "Не удалось открыть атлас персонажей; системный голос доступен."]) }
        }
        configureCallbacks(); configurePanel(); configureMenu()
        emitReady()
        if CommandLine.arguments.contains("--preview") || argument("--snapshot") != nil || config["showOnStart"] as? Bool == true {
            showPreview()
        }
        if let output = argument("--snapshot") {
            guard view.atlas != nil else {
                emit(["type": "error", "code": "atlas", "message": "Для снимка нужен атлас персонажей."])
                exitStatus = 1; NSApp.terminate(nil); return
            }
            view.snapshot(output); NSApp.terminate(nil); return
        }
        if speechTest {
            testSpeech()
            speechTestTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { _ in
                emit(["type": "error", "code": "speech-timeout", "message": "Системный синтезатор не завершил проверку за 30 секунд."])
                exitStatus = 1; NSApp.terminate(nil)
            }
        } else { readCommands() }
    }

    func configureCallbacks() {
        speech.onStarted = { [weak self] id, text in self?.view.speaker = id; self?.view.bubble = text }
        speech.onReset = { [weak self] in self?.view.speaker = nil; self?.view.mouthUntil = 0; self?.view.bubble = "" }
        speech.onEvent = { [weak self] phase, id, range in
            var event: [String: Any] = ["type": "speech", "phase": phase, "characterId": id]
            if let range {
                event["offset"] = range.location; event["length"] = range.length
                // Native word boundaries approximate mouth motion; they are not phoneme timings.
                self?.view.mouthUntil = Date.timeIntervalSinceReferenceDate + min(0.24, 0.06 + Double(range.length) * 0.025)
            }
            emit(event)
            if phase == "end" { self?.speechTestCompleted = true }
        }
        speech.onDrained = { [weak self] in
            if self?.speechTest == true {
                if self?.speechTestCompleted != true {
                    emit(["type": "error", "code": "speech-cancelled", "message": "Проверка системного голоса прервана."])
                    exitStatus = 1
                }
                self?.speechTestTimer?.invalidate(); NSApp.terminate(nil)
            }
        }
        dictation.onPreparing = { [weak self] in
            self?.speech.suspended = true; self?.speech.stop(); self?.updateMenu()
        }
        dictation.onState = { [weak self] active in
            self?.speech.suspended = active; self?.updateMenu()
            emit(["type": "dictation", "active": active])
        }
        dictation.onTranscript = { text in emit(["type": "transcript", "text": text]) }
        dictation.onError = { message in emit(["type": "error", "code": "dictation", "message": message]) }
    }

    func configurePanel() {
        panel.backgroundColor = .clear; panel.isOpaque = false; panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = true; panel.contentView = view
        panel.setFrameOrigin(NSPoint(x: 20, y: 40))
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 24, repeats: true) { [weak self] _ in self?.view.needsDisplay = true }
    }

    func configureMenu() {
        let menu = NSMenu()
        let voiceMenu = NSMenu()
        for voice in AVSpeechSynthesisVoice.speechVoices().sorted(by: { ($0.language, $0.name) < ($1.language, $1.name) }) {
            let entry = NSMenuItem(title: "\(voice.name) — \(voice.language)", action: #selector(selectVoice(_:)), keyEquivalent: "")
            entry.target = self; entry.representedObject = voice.identifier
            voiceMenu.addItem(entry); voiceItems.append(entry)
        }
        let voices = menu.addItem(withTitle: "Системный голос macOS", action: nil, keyEquivalent: "")
        voices.submenu = voiceMenu
        menu.addItem(withTitle: "Проверить голос", action: #selector(testSpeech), keyEquivalent: "")
        muteItem = menu.addItem(withTitle: "Выключить голос", action: #selector(toggleMute), keyEquivalent: "")
        menu.addItem(withTitle: "Остановить речь", action: #selector(stopSpeech), keyEquivalent: "")
        menu.addItem(.separator())
        startItem = menu.addItem(withTitle: "Начать диктовку…", action: #selector(startDictation), keyEquivalent: "")
        finishItem = menu.addItem(withTitle: "Завершить диктовку", action: #selector(finishDictation), keyEquivalent: "")
        cancelItem = menu.addItem(withTitle: "Отменить диктовку", action: #selector(cancelDictation), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Показать команду", action: #selector(showPreview), keyEquivalent: "")
        menu.addItem(withTitle: "Закрыть CodexBridge Companions", action: #selector(quit), keyEquivalent: "q")
        menu.autoenablesItems = false
        for entry in menu.items { entry.target = self }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item?.button?.title = "✦"; item?.button?.toolTip = "CodexBridge: голос и персонажи"; item?.menu = menu
        updateMenu()
    }

    func updateMenu() {
        muteItem?.state = speech.muted ? .on : .off
        startItem?.isEnabled = dictationEnabled && !dictation.active
        finishItem?.isEnabled = dictation.active; cancelItem?.isEnabled = dictation.active
        item?.button?.title = dictation.active ? "● ✦" : "✦"
        for entry in voiceItems { entry.state = entry.representedObject as? String == speech.voice?.identifier ? .on : .off }
    }

    func emitReady() {
        emit(["type": "ready", "voice": speech.voice?.identifier ?? "system-default",
              "language": speech.voice?.language ?? language, "graphics": view.atlas != nil])
    }

    func readCommands() {
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
        let count = CGFloat(max(view.characters.count, 1))
        panel.setContentSize(NSSize(width: count * 168 * scale, height: 330 * scale))
        view.setBoundsSize(NSSize(width: count * 168, height: 330))
    }

    func receive(_ value: [String: Any]) {
        guard let type = value["type"] as? String else { return }
        switch type {
        case "preview": showPreview()
        case "mute": speech.setMuted(value["muted"] as? Bool ?? !speech.muted); updateMenu()
        case "stop-speech": stopSpeech()
        case "speech-test": testSpeech()
        case "show-menu": item?.button?.performClick(nil)
        case "dictation-start": startDictation()
        case "dictation-stop": finishDictation()
        case "dictation-cancel": cancelDictation()
        default: receiveCharacter(value)
        }
        view.needsDisplay = true
    }

    func receiveCharacter(_ value: [String: Any]) {
        guard let type = value["type"] as? String, let id = value["characterId"] as? String else { return }
        switch type {
        case "state":
            let appearance = value["appearance"] as? [String: Any] ?? [:]
            let character = Character(id: id, column: min(max(appearance["column"] as? Int ?? 0, 0), 3),
                label: appearance["label"] as? String ?? "LEAD", state: value["state"] as? String ?? "idle",
                headColumn: appearance["headColumn"] as? Int, bodyColumn: appearance["bodyColumn"] as? Int)
            view.characters.removeAll { $0.id.hasPrefix("preview-") }
            if let index = view.characters.firstIndex(where: { $0.id == id }) { view.characters[index] = character }
            else {
                if view.characters.count >= maxVisible { view.characters.removeFirst() }
                view.characters.append(character)
            }
            resize()
            if view.atlas != nil { panel.orderFrontRegardless() }
        case "speak":
            if let text = value["text"] as? String { speech.enqueue(characterId: id, text: text) }
        case "stop": speech.stop(characterId: id)
        case "remove":
            speech.stop(characterId: id); view.characters.removeAll { $0.id == id }; resize()
            if view.characters.isEmpty { panel.orderOut(nil) }
        default: break
        }
    }

    @objc func showPreview() {
        guard view.atlas != nil else { return }
        view.characters = ["LEAD", "CODE", "RESEARCH", "REVIEW"].prefix(maxVisible).enumerated().map {
            Character(id: "preview-\($0.offset)", column: $0.offset, label: $0.element, state: "idle")
        }
        resize(); panel.orderFrontRegardless()
    }

    @objc func selectVoice(_ sender: NSMenuItem) {
        speech.selectVoice(identifier: sender.representedObject as? String, language: language)
        updateMenu(); emitReady()
    }

    @objc func testSpeech() {
        guard !dictation.active else { return }
        speech.setMuted(false); updateMenu()
        speech.enqueue(characterId: view.characters.first?.id ?? "system-speech-test", text: "Проверка системного голоса. Задача в работе.")
    }

    @objc func toggleMute() { speech.setMuted(!speech.muted); updateMenu() }
    @objc func stopSpeech() { speech.stop() }
    @objc func startDictation() {
        guard dictationEnabled else { return }
        dictation.start(language: language)
    }
    @objc func finishDictation() { dictation.finish() }
    @objc func cancelDictation() { dictation.cancel() }
    @objc func quit() { NSApp.terminate(nil) }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate(); speechTestTimer?.invalidate(); dictation.cancel(); speech.stop()
    }
}

signal(SIGPIPE, SIG_IGN)
if CommandLine.arguments.contains("--list-voices") {
    for voice in AVSpeechSynthesisVoice.speechVoices() {
        emit(["identifier": voice.identifier, "name": voice.name, "language": voice.language])
    }
} else {
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = CompanionApp()
        app.delegate = delegate
        app.run()
    }
}
exit(exitStatus)
