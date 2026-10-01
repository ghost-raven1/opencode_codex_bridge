import AppKit
import AVFoundation
import Darwin

func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

func readConfiguration() -> [String: Any] {
    guard let raw = argument("--config"), let data = raw.data(using: .utf8) else { return [:] }
    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
}

func configuredDictation(_ config: [String: Any]) -> Bool {
    UserDefaults.standard.object(forKey: "companions.dictationEnabled") as? Bool
        ?? config["dictation"] as? Bool ?? true
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
    let panel = CompanionPanel(contentRect: NSRect(x: 0, y: 0, width: 672, height: 330),
        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    let speech = NativeSpeech()
    let dictation = NativeDictation()
    let draftMenu = DraftMenu()
    var realCharacters: [Character] = []
    var demonstration = false
    var timer: Timer?
    var speechTestTimer: Timer?
    var item: NSStatusItem?
    var muteItem: NSMenuItem?
    var visibilityItem: NSMenuItem?
    var windowState: WindowState!
    var startItem: NSMenuItem?
    var finishItem: NSMenuItem?
    var cancelItem: NSMenuItem?
    var dictationToggleItem: NSMenuItem?
    var voiceItems: [NSMenuItem] = []
    var language = "ru-RU"
    var dictationEnabled = true
    var localSpeech = false
    var maxVisible = 4
    var scale: CGFloat = 1
    var speechTest = CommandLine.arguments.contains("--speech-test")
    var speechTestCompleted = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = readConfiguration()
        maxVisible = min(max(config["maxVisible"] as? Int ?? 4, 1), 4)
        scale = min(max(config["scale"] as? Double ?? 1, 0.5), 2)
        language = config["language"] as? String ?? "ru-RU"
        dictationEnabled = configuredDictation(config)
        localSpeech = (config["tts"] as? [String: Any])?["engine"] as? String == "local"
        speech.selectVoice(identifier: config["voiceIdentifier"] as? String, language: language)
        if let path = argument("--atlas") {
            view.atlas = NSImage(contentsOfFile: path)
            let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
            view.headAtlas = NSImage(contentsOf: directory.appendingPathComponent("head-atlas.png"))
            view.bodyAtlas = NSImage(contentsOf: directory.appendingPathComponent("body-atlas.png"))
            view.mixedHeadAtlas = NSImage(contentsOf: directory.appendingPathComponent("mixed-head-atlas.png"))
            view.mixedBodyAtlas = NSImage(contentsOf: directory.appendingPathComponent("mixed-body-atlas.png"))
            view.faceAtlas = NSImage(contentsOf: directory.appendingPathComponent("facial-v3.png"))
            view.clips.load(directory)
            let poses = NSImage(contentsOf: directory.appendingPathComponent("poses.png"))
            let transitions = NSImage(contentsOf: directory.appendingPathComponent("transitions.png"))
            if poses?.size == NSSize(width: 1024, height: 1920), transitions?.size == NSSize(width: 1024, height: 1920) {
                view.poseAtlas = poses; view.transitionAtlas = transitions
            }
            if view.atlas == nil { emit(["type": "error", "code": "atlas", "message": "Не удалось открыть атлас персонажей; системный голос доступен."]) }
        }
        configureCallbacks(); configurePanel(); configureMenu()
        emitReady()
        if CommandLine.arguments.contains("--preview") || argument("--snapshot") != nil {
            populatePreview()
        }
        if let output = argument("--snapshot") {
            guard view.atlas != nil else {
                emit(["type": "error", "code": "atlas", "message": "Для снимка нужен атлас персонажей."])
                exitStatus = 1; NSApp.terminate(nil); return
            }
            if !view.snapshot(output) { exitStatus = 1; emit(["type": "error", "message": "Не удалось сохранить снимок."]) }
            NSApp.terminate(nil); return
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
        view.onBubbleChange = { [weak self] in self?.resize() }
        speech.onStarted = { [weak self] id, text in self?.view.speaker = id; self?.view.bubble = text }
        speech.onReset = { [weak self] in self?.view.speaker = nil; self?.view.mouthUntil = 0; self?.view.mouthLevel = 0; self?.view.bubble = "" }
        speech.onLevel = { [weak self] level in self?.view.mouthLevel = level }
        speech.onAmplitude = { [weak self] open in
            self?.view.mouthUntil = open ? Date.timeIntervalSinceReferenceDate + 0.06 : 0
        }
        speech.onAudioFinished = { id, phase in emit(["type": "audio-finished", "id": id, "phase": phase]) }
        speech.onEvent = { [weak self] phase, id, range in
            var event: [String: Any] = ["type": "speech", "phase": phase, "characterId": id]
            if let range {
                event["offset"] = range.location; event["length"] = range.length
                // Native word boundaries approximate mouth motion; they are not phoneme timings.
                self?.view.mouthUntil = Date.timeIntervalSinceReferenceDate + min(0.24, 0.06 + Double(range.length) * 0.025)
                self?.view.mouthLevel = 0.65
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
            emit(["type": "speech-control", "action": "suspend", "suspended": true])
            self?.speech.suspended = true; self?.speech.stop(); self?.updateMenu()
        }
        dictation.onState = { [weak self] active in
            self?.speech.suspended = active; self?.updateMenu()
            emit(["type": "dictation", "active": active])
            emit(["type": "speech-control", "action": "suspend", "suspended": active])
        }
        dictation.onTranscript = { text in emit(["type": "transcript", "text": text]) }
        dictation.onError = { message in emit(["type": "error", "code": "dictation", "message": message]) }
    }

    func configurePanel() {
        panel.backgroundColor = .clear; panel.isOpaque = false; panel.hasShadow = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = false; panel.contentView = view
        view.toolTip = "Перетащи персонажа или подпись, чтобы переместить группу. Правый клик — скрыть."
        windowState = WindowState(panel: panel)
        windowState.onChange = { [weak self] in self?.updateMenu() }
        let context = NSMenu()
        context.addItem(withTitle: "Скрыть компаньонов", action: #selector(hideCompanions), keyEquivalent: "")
        context.addItem(withTitle: "Вернуть позицию на экран", action: #selector(resetPosition), keyEquivalent: "")
        for entry in context.items { entry.target = self }
        view.menu = context

    }

    func configureMenu() {
        let menu = NSMenu()
        if localSpeech {
            let engine = menu.addItem(withTitle: "Qwen3-TTS · 4 локальных голоса", action: nil, keyEquivalent: "")
            engine.isEnabled = false
        }
        let voiceMenu = NSMenu()
        for voice in AVSpeechSynthesisVoice.speechVoices().sorted(by: { ($0.language, $0.name) < ($1.language, $1.name) }) {
            let entry = NSMenuItem(title: "\(voice.name) — \(voice.language)", action: #selector(selectVoice(_:)), keyEquivalent: "")
            entry.target = self; entry.representedObject = voice.identifier
            voiceMenu.addItem(entry); voiceItems.append(entry)
        }
        let voices = menu.addItem(withTitle: localSpeech ? "Резервный голос macOS" : "Системный голос macOS", action: nil, keyEquivalent: "")
        voices.submenu = voiceMenu
        menu.addItem(withTitle: "Проверить голос", action: #selector(testSpeech), keyEquivalent: "")
        muteItem = menu.addItem(withTitle: "Выключить голос", action: #selector(toggleMute), keyEquivalent: "")
        menu.addItem(withTitle: "Остановить речь", action: #selector(stopSpeech), keyEquivalent: "")
        menu.addItem(.separator())
        dictationToggleItem = menu.addItem(withTitle: "Выключить диктовку", action: #selector(toggleDictation), keyEquivalent: "")
        startItem = menu.addItem(withTitle: "Начать диктовку…", action: #selector(startDictation), keyEquivalent: "")
        finishItem = menu.addItem(withTitle: "Завершить диктовку", action: #selector(finishDictation), keyEquivalent: "")
        cancelItem = menu.addItem(withTitle: "Отменить диктовку", action: #selector(cancelDictation), keyEquivalent: "")
        menu.addItem(withTitle: "Черновики диктовки", action: nil, keyEquivalent: "").submenu = draftMenu.menu
        menu.addItem(.separator())
        visibilityItem = menu.addItem(withTitle: "Скрыть компаньонов", action: #selector(toggleVisibility), keyEquivalent: "")
        menu.addItem(withTitle: "Вернуть позицию на экран", action: #selector(resetPosition), keyEquivalent: "")
        menu.addItem(withTitle: "Демо персонажей (отдельный просмотр)", action: #selector(showPreview), keyEquivalent: "")
        menu.addItem(withTitle: "Закрыть CodexBridge Companions", action: #selector(quit), keyEquivalent: "q")
        menu.autoenablesItems = false
        for entry in menu.items { entry.target = self }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item?.button?.title = "✦"; item?.button?.toolTip = "CodexBridge: голос и персонажи"; item?.menu = menu
        updateMenu()
    }

    func updateMenu() {
        muteItem?.state = speech.muted ? .on : .off
        visibilityItem?.title = windowState?.hidden == true ? "Показать компаньонов" : "Скрыть компаньонов"
        dictationToggleItem?.title = dictationEnabled ? "Выключить диктовку" : "Включить диктовку"
        startItem?.isEnabled = dictationEnabled && !dictation.active
        finishItem?.isEnabled = dictation.active; cancelItem?.isEnabled = dictation.active
        item?.button?.title = dictation.active ? "● ✦" : "✦"
        for entry in voiceItems { entry.state = entry.representedObject as? String == speech.voice?.identifier ? .on : .off }
    }

    func emitReady() {
        emit(["type": "ready", "voice": speech.voice?.identifier ?? "system-default",
              "language": speech.voice?.language ?? language, "graphics": view.atlas != nil,
              "pid": ProcessInfo.processInfo.processIdentifier])
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
        let width = count * 168, height = view.contentHeight(width: width)
        panel.setContentSize(NSSize(width: width * scale, height: height * scale))
        view.setBoundsSize(NSSize(width: width, height: height))
        windowState.fitToScreen()
    }

    func receive(_ value: [String: Any]) {
        guard let type = value["type"] as? String else { return }
        switch type {
        case "drafts": draftMenu.update(value)
        case "draft-text": draftMenu.receiveText(value)
        case "snapshot":
            if let path = value["path"] as? String {
                let previousBubble = view.bubble
                if let caption = value["caption"] as? String { view.bubble = caption }
                view.snapshotTime = Date.timeIntervalSinceReferenceDate + (value["offset"] as? Double ?? 0)
                view.snapshotBackground = value["background"] as? String
                let saved = view.snapshot(path); view.snapshotTime = nil; view.snapshotBackground = nil
                let diagnostics = view.speechBubble.diagnostics
                if value["caption"] is String { view.bubble = previousBubble }
                emit(saved ? ["type": "snapshot", "path": path, "bubble": diagnostics] : ["type": "error", "message": "Не удалось сохранить снимок."])
            }
        case "preview": showPreview()
        case "hide": hideCompanions()
        case "show": showCompanions()
        case "reset-position": resetPosition()
        case "window-status": emitWindowStatus()
        case "mute": setMuted(value["muted"] as? Bool ?? !speech.muted)
        case "stop-speech": stopSpeech()
        case "speech-test": testSpeech()
        case "show-menu": item?.button?.performClick(nil)
        case "dictation-start": startDictation()
        case "dictation-stop": finishDictation()
        case "dictation-cancel": cancelDictation()
        case "dictation-enable": setDictationEnabled(true)
        case "dictation-disable": setDictationEnabled(false)
        case "dictation-status": emitDictationStatus()
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
            if let index = realCharacters.firstIndex(where: { $0.id == id }) { realCharacters[index] = character }
            else { realCharacters.append(character) }
            if demonstration { demonstration = false; view.replace(Array(realCharacters.prefix(maxVisible))) }
            if !view.characters.contains(where: { $0.id == id }), view.characters.count >= maxVisible,
               let evicted = view.characters.first(where: { $0.id != view.speaker }) {
                view.remove(evicted.id, immediately: true)
            }
            view.update(character)
            resize()
            presentCharacters()
        case "speak":
            if let text = value["text"] as? String {
                speech.enqueue(characterId: id, text: text, role: value["role"] as? String ?? "coordinator",
                    audioId: value["audioId"] as? String)
            }
        case "play-audio":
            if let path = value["path"] as? String, let audioId = value["audioId"] as? String {
                speech.enqueueAudio(characterId: id, text: value["text"] as? String ?? "",
                    role: value["role"] as? String ?? "coordinator", path: path, audioId: audioId)
            }
        case "stop": speech.stop(characterId: id)
        case "remove":
            if value["visualOnly"] as? Bool != true { speech.stop(characterId: id) }
            realCharacters.removeAll { $0.id == id }
            view.remove(id, immediately: value["visualOnly"] as? Bool == true)
            resize(); presentCharacters()
        default: break
        }
    }

    func populatePreview() {
        guard view.atlas != nil else { return }
        let state = argument("--snapshot-state") ?? "idle"
        demonstration = true
        let entries = ["LEAD", "CODE", "RESEARCH", "REVIEW"].prefix(maxVisible).enumerated().map {
            Character(id: "preview-\($0.offset)", column: $0.offset, label: $0.element, state: state)
        }
        view.replace(entries, animated: argument("--snapshot") == nil)
        resize(); presentCharacters()
    }

    func presentCharacters() {
        windowState.present(hasContent: view.atlas != nil && !view.characters.isEmpty)
        if panel.isVisible && !view.characters.isEmpty {
            if timer == nil {
                timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 24, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        if self.view.tick() { self.resize(); self.presentCharacters() }
                    }
                }
            }
        } else { timer?.invalidate(); timer = nil }
    }

    func emitWindowStatus() {
        emit(["type": "window", "hidden": windowState.hidden, "visible": panel.isVisible,
              "x": panel.frame.minX, "y": panel.frame.minY, "count": view.characters.count,
              "characters": view.characters.map { $0.id }, "rendering": timer != nil, "demo": demonstration,
              "columns": view.characters.map { $0.column }, "reducedMotion": view.reduced])
    }

    @objc func showPreview() {
        windowState.setHidden(false); populatePreview(); emitWindowStatus()
    }

    @objc func hideCompanions() {
        windowState.setHidden(true); presentCharacters(); emitWindowStatus()
    }

    @objc func showCompanions() {
        windowState.setHidden(false)
        if demonstration { demonstration = false; view.replace(realCharacters) }
        view.tick(); resize(); presentCharacters()
        emitWindowStatus()
    }

    @objc func toggleVisibility() {
        if windowState.hidden { showCompanions() } else { hideCompanions() }
    }

    @objc func resetPosition() {
        windowState.resetPosition(); showCompanions()
    }

    @objc func selectVoice(_ sender: NSMenuItem) {
        speech.selectVoice(identifier: sender.representedObject as? String, language: language)
        updateMenu(); emitReady()
    }

    @objc func testSpeech() {
        guard !dictation.active else { return }
        speech.setMuted(false); updateMenu()
        emit(["type": "speech-control", "action": "mute", "muted": false])
        if localSpeech && !speechTest { emit(["type": "test-voices"]); return }
        speech.enqueue(characterId: view.characters.first?.id ?? "system-speech-test", text: "Проверка системного голоса. Задача в работе.")
    }

    func setMuted(_ muted: Bool) {
        emit(["type": "speech-control", "action": "mute", "muted": muted])
        speech.setMuted(muted); updateMenu()
    }
    @objc func toggleMute() { setMuted(!speech.muted) }
    @objc func stopSpeech() { emit(["type": "speech-control", "action": "stop"]); speech.stop() }
    func setDictationEnabled(_ enabled: Bool) {
        dictationEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: "companions.dictationEnabled")
        if !enabled { dictation.cancel() }
        updateMenu(); emitDictationStatus()
    }
    func emitDictationStatus() { emit(dictation.status(enabled: dictationEnabled, language: language)) }
    @objc func toggleDictation() { setDictationEnabled(!dictationEnabled) }
    @objc func startDictation() {
        guard dictationEnabled else { emitDictationStatus(); return }
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
if let directory = argument("--ipc-directory"), !FileManager.default.fileExists(atPath: directory) { exit(0) }
if let directory = argument("--ipc-directory") {
    emit(["type": "process", "pid": ProcessInfo.processInfo.processIdentifier])
    let parentPid = argument("--ipc-parent-pid").flatMap { Int32($0) }
    DispatchQueue.global(qos: .utility).async {
        while FileManager.default.fileExists(atPath: directory) {
            if let parentPid, kill(parentPid, 0) == -1 && errno == ESRCH { break }
            Thread.sleep(forTimeInterval: 0.25)
        }
        _exit(0)
    }
}
if CommandLine.arguments.contains("--dictation-status") {
    MainActor.assumeIsolated {
        let config = readConfiguration()
        emit(NativeDictation().status(enabled: configuredDictation(config), language: config["language"] as? String ?? "ru-RU"))
    }
} else if CommandLine.arguments.contains("--list-voices") {
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
