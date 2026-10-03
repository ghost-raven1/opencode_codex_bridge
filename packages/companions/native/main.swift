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
    let speechStatus = NativeSpeechStatus()
    let dictation = NativeDictation()
    var wake: WakeControl!
    let draftMenu = DraftMenu()
    let music = MusicControl()
    var realCharacters: [Character] = []
    var captions = CaptionState()
    var demonstration = false
    var timer: Timer?
    var speechTestTimer: Timer?
    var item: NSStatusItem?
    var microphoneItem: NSStatusItem?
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
    var scaleControl: ScaleControl!
    var speechTest = CommandLine.arguments.contains("--speech-test")
    var speechTestCompleted = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = readConfiguration()
        maxVisible = min(max(config["maxVisible"] as? Int ?? 4, 1), 4)
        scaleControl = ScaleControl(configured: config["scale"] as? Double ?? 1)
        language = config["language"] as? String ?? "ru-RU"
        dictationEnabled = configuredDictation(config)
        localSpeech = (config["tts"] as? [String: Any])?["engine"] as? String == "local"
        speech.selectVoice(identifier: config["voiceIdentifier"] as? String, language: language)
        if let path = argument("--atlas") {
            view.atlas = NSImage(contentsOfFile: path)
            let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
            view.loadRigs(directory: directory.appendingPathComponent("expansion"))
            view.headAtlas = NSImage(contentsOf: directory.appendingPathComponent("head-atlas.png"))
            view.bodyAtlas = NSImage(contentsOf: directory.appendingPathComponent("body-atlas.png"))
            view.mixedHeadAtlas = NSImage(contentsOf: directory.appendingPathComponent("mixed-head-atlas.png"))
            view.mixedBodyAtlas = NSImage(contentsOf: directory.appendingPathComponent("mixed-body-atlas.png"))
            view.faceAtlas = NSImage(contentsOf: directory.appendingPathComponent("facial-v3.png"))
            if view.atlas == nil { emit(["type": "error", "code": "atlas", "message": "Не удалось открыть атлас персонажей; системный голос доступен."]) }
        }
        configureCallbacks(); configurePanel(); configureMusic(); configureDictation(config); configureMenu()
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
        configureStreamCallbacks()
        configureCaptionCallbacks()
        view.onBubbleChange = { [weak self] in self?.resize() }
        speech.onStarted = { [weak self] id, text in
            guard let self else { return }
            self.view.speaker = id
            if !self.captions.contains(id) { self.captions.update(id, text: text) }
            self.refreshCaption()
            self.updateMenu()
        }
        speech.onReset = { [weak self] in
            self?.view.speaker = nil; self?.view.mouthUntil = 0; self?.view.mouthLevel = 0
            self?.refreshCaption(); self?.updateMenu()
        }
        speech.onLevel = { [weak self] level in self?.view.mouthLevel = level }
        speech.onAmplitude = { [weak self] open in
            self?.view.mouthUntil = open ? Date.timeIntervalSinceReferenceDate + 0.06 : 0
        }
        speech.onAudioFinished = { id, phase in emit(["type": "audio-finished", "id": id, "phase": phase]) }
        speech.onAudioStarted = { id in emit(["type": "audio-started", "id": id]) }
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

    }

    func configureMenu() {
        let menu = NSMenu()
        speechStatus.attach(to: menu, localVoice: localSpeech) { emit(["type": "speech-control", "action": "recover"]) }
        if localSpeech {
            let engine = menu.addItem(withTitle: "Qwen3-TTS · локальные голоса", action: nil, keyEquivalent: "")
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
        menu.addItem(withTitle: "Команды голосового управления…", action: #selector(showVoiceHelp), keyEquivalent: "")
        menu.addItem(withTitle: "Черновики диктовки", action: nil, keyEquivalent: "").submenu = draftMenu.menu
        menu.addItem(wake.menuItem); menu.addItem(wake.statusItem)
        menu.addItem(music.menuItem); menu.addItem(music.statusItem)
        menu.addItem(.separator())
        visibilityItem = menu.addItem(withTitle: "Скрыть компаньонов", action: #selector(toggleVisibility), keyEquivalent: "")
        menu.addItem(scaleControl.menuItem)
        menu.addItem(withTitle: "Вернуть позицию на экран", action: #selector(resetPosition), keyEquivalent: "")
        menu.addItem(withTitle: "Демо персонажей (отдельный просмотр)", action: #selector(showPreview), keyEquivalent: "")
        menu.addItem(withTitle: "Закрыть CodexBridge Companions", action: #selector(quit), keyEquivalent: "q")
        menu.autoenablesItems = false
        for entry in menu.items where entry.target == nil { entry.target = self }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item?.button?.title = "✦"; item?.button?.toolTip = "CodexBridge: голос и персонажи"; item?.menu = menu
        microphoneItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        microphoneItem?.button?.target = self; microphoneItem?.button?.action = #selector(toggleRecording)
        updateMenu()
    }

    func updateMenu() {
        speechStatus.update(muted: speech.muted, suspended: speech.suspended, playback: speech.playbackPhase)
        muteItem?.state = speech.muted ? .on : .off
        visibilityItem?.title = windowState?.hidden == true ? "Показать компаньонов" : "Скрыть компаньонов"
        dictationToggleItem?.title = dictationEnabled ? "Выключить диктовку" : "Включить диктовку"
        startItem?.isEnabled = dictationEnabled && !dictation.active
        finishItem?.isEnabled = dictation.active; cancelItem?.isEnabled = dictation.active
        item?.button?.title = dictation.active ? "● ✦" : "✦"
        microphoneItem?.isVisible = dictationEnabled
        microphoneItem?.button?.image = NSImage(systemSymbolName: dictation.active ? "stop.circle.fill" : "mic.fill", accessibilityDescription: "Диктовка")
        microphoneItem?.button?.contentTintColor = dictation.active ? .systemRed : nil
        microphoneItem?.button?.toolTip = dictation.active ? "Завершить диктовку без отправки. Для отправки скажи «Отправить»." : "Начать диктовку. После текста сделай паузу и скажи «Отправить»."
        for entry in voiceItems { entry.state = entry.representedObject as? String == speech.voice?.identifier ? .on : .off }
        updateMusicIndicator(); updateWakeIndicator()
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

    func receive(_ value: [String: Any]) {
        if receiveStream(value) { return }
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
                if value["caption"] is String { view.bubble = previousBubble; refreshCaption() }
                emit(saved ? ["type": "snapshot", "path": path, "bubble": diagnostics] : ["type": "error", "message": "Не удалось сохранить снимок."])
            }
        case "preview": showPreview()
        case "hide": hideCompanions()
        case "show": showCompanions()
        case "reset-position": resetPosition()
        case "window-status": emitWindowStatus()
        case "set-scale": if let scale = value["scale"] as? Double { scaleControl.set(scale) }
        case "reset-scale": scaleControl.reset()
        case "mute": setMuted(value["muted"] as? Bool ?? !speech.muted)
        case "stop-speech": stopSpeech()
        case "speech-test": testSpeech()
        case "speech-status": speechStatus.receive(value); updateMenu()
        case "reset-speech": speech.resetSynthesizer(); updateMenu()
        case "show-menu": item?.button?.performClick(nil)
        case "voice-help": showVoiceHelp()
        case "dictation-start": startDictation()
        case "dictation-stop": finishDictation()
        case "dictation-cancel": cancelDictation()
        case "dictation-enable": setDictationEnabled(true)
        case "dictation-disable": setDictationEnabled(false)
        case "dictation-status": emitDictationStatus()
        case "wake-enable": setDictationEnabled(true); wake.setEnabled(true); emit(wake.status)
        case "wake-disable": wake.setEnabled(false); emit(wake.status)
        case "wake-status": emit(wake.status)
        case "music-enable": setDictationEnabled(true); music.setEnabled(true); emit(music.status)
        case "music-disable": music.setEnabled(false); emit(music.status)
        case "music-status": emit(music.status)
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
                headColumn: appearance["headColumn"] as? Int, bodyColumn: appearance["bodyColumn"] as? Int,
                rig: appearance["rig"] as? String, name: value["name"] as? String,
                parentID: value["parentCharacterId"] as? String, invocationID: value["invocationId"] as? String,
                activity: value["activity"] as? String)
            if let index = realCharacters.firstIndex(where: { $0.id == id }) { realCharacters[index] = character }
            else { realCharacters.append(character) }
            if demonstration { demonstration = false; view.replace(Array(realCharacters.prefix(maxVisible))) }
            if !view.characters.contains(where: { $0.id == id }), view.characters.count >= maxVisible,
               let evicted = view.characters.first(where: { $0.id != view.speaker }) {
                view.remove(evicted.id, immediately: true)
            }
            view.update(character)
            refreshCaption()
            resize()
            presentCharacters()
        case "caption":
            captions.update(id, text: value["text"] as? String ?? "", captionId: value["captionId"] as? String,
                animated: value["animated"] as? Bool == true)
            refreshCaption()
        case "speak":
            if let text = value["text"] as? String {
                if value["resetVoice"] as? Bool == true { speech.resetSynthesizer() }
                speech.enqueue(characterId: id, text: text, role: value["role"] as? String ?? "coordinator",
                    audioId: value["audioId"] as? String, captionId: value["captionId"] as? String,
                    captionOffset: value["captionOffset"] as? Int ?? 0)
            }
        case "play-audio":
            if let path = value["path"] as? String, let audioId = value["audioId"] as? String {
                speech.enqueueAudio(characterId: id, text: value["text"] as? String ?? "",
                    role: value["role"] as? String ?? "coordinator", path: path, audioId: audioId,
                    captionId: value["captionId"] as? String, captionOffset: value["captionOffset"] as? Int ?? 0)
            }
        case "stop": speech.stop(characterId: id)
        case "remove":
            if value["visualOnly"] as? Bool != true { speech.stop(characterId: id); captions.update(id, text: "") }
            realCharacters.removeAll { $0.id == id }
            view.remove(id, immediately: value["visualOnly"] as? Bool == true)
            refreshCaption()
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
        refreshCaption()
        resize(); presentCharacters()
    }

    func presentCharacters() {
        let wasRendering = timer != nil
        defer { emitRendererState(previous: wasRendering) }
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
        emit(["type": "window", "teamActions": view.teamActionKinds, "hidden": windowState.hidden, "visible": panel.isVisible,
              "scale": scaleControl.value, "effectiveScale": scaleControl.effective,
              "width": panel.frame.width, "height": panel.frame.height,
              "contentWidth": view.frame.width, "contentHeight": view.frame.height,
              "logicalWidth": view.bounds.width, "logicalHeight": view.bounds.height,
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
        refreshCaption()
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
        updateMenu()
    }

    func setMuted(_ muted: Bool) {
        emit(["type": "speech-control", "action": "mute", "muted": muted])
        speech.setMuted(muted); updateMenu()
    }
    @objc func toggleMute() { setMuted(!speech.muted) }
    @objc func stopSpeech() {
        emit(["type": "speech-control", "action": "stop"]); speech.stop()
        captions = CaptionState(); refreshCaption()
    }
    @objc func quit() { NSApp.terminate(nil) }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate(); speechTestTimer?.invalidate(); wake.stop(); music.stop(); dictation.cancel(); speech.stop()
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
