import AppKit

@MainActor extension CompanionApp {
    func configureDictation(_ config: [String: Any]) {
        wake = WakeControl(dictation: dictation)
        wake.onChange = { [weak self] in self?.updateMenu() }
        wake.onDiagnostic = { emit($0) }
        dictation.onPreparing = { [weak self] in
            self?.music.setDictating(true)
            emit(["type": "speech-control", "action": "suspend", "suspended": true])
            self?.speech.suspended = true; self?.speech.stop(); self?.updateMenu()
        }
        dictation.onState = { [weak self] active in
            self?.music.setDictating(active)
            self?.speech.suspended = active; self?.updateMenu()
            emit(["type": "dictation", "active": active])
            emit(["type": "speech-control", "action": "suspend", "suspended": active])
        }
        dictation.onTranscript = { text in emit(["type": "transcript", "text": text]) }
        dictation.onCommand = { input in emit(["type": "voice-command", "command": input.command, "text": input.text]) }
        dictation.onError = { message in emit(["type": "error", "code": "dictation", "message": message]) }
        dictation.onListening = { [weak self] _ in self?.wake.captureChanged() }
        dictation.onWake = { [weak self] in self?.wake.triggered() }
        dictation.onWakeError = { [weak self] message in
            self?.wake.captureFailed(); emit(["type": "error", "code": "wake-word", "message": message])
        }
        wake.configure(configured: config["wakeWord"] as? Bool ?? false, allowed: dictationEnabled, language: language)
    }

    func updateWakeIndicator() {
        wake?.update(allowed: dictationEnabled, dictating: dictation.active, speaking: speech.playbackPhase != nil)
        guard dictation.listening, !dictation.active else { return }
        microphoneItem?.button?.image = NSImage(systemSymbolName: "ear.badge.waveform", accessibilityDescription: "Слушаю слово OpenCode")
        microphoneItem?.button?.contentTintColor = .systemBlue
        let mode = music.listening ? "«OpenCode» и музыку" : "«OpenCode»"
        microphoneItem?.button?.toolTip = "Микрофон слушает \(mode). Скажи «OpenCode», надиктуй запрос и скажи «Отправить». Отключение — в меню ✦."
    }

    func setDictationEnabled(_ enabled: Bool) {
        dictationEnabled = enabled
        if enabled { music.configure(allowed: true) } else { wake.disableMicrophone(); music.disableMicrophone() }
        UserDefaults.standard.set(enabled, forKey: "companions.dictationEnabled")
        if !enabled { dictation.cancel() }
        updateMenu(); emitDictationStatus()
    }
    func emitDictationStatus() { emit(dictation.status(enabled: dictationEnabled, language: language)); emit(wake.status) }
    @objc func toggleDictation() { setDictationEnabled(!dictationEnabled) }
    @objc func startDictation() {
        guard dictationEnabled else { emitDictationStatus(); return }
        dictation.start(language: language)
    }
    @objc func finishDictation() { dictation.finish() }
    @objc func cancelDictation() { dictation.cancel() }
    @objc func toggleRecording() { if dictation.active { finishDictation() } else { startDictation() } }
    @objc func showVoiceHelp() {
        let alert = NSAlert(); alert.messageText = "Голосовое управление OpenCode"
        alert.informativeText = VoiceCommands.help; alert.addButton(withTitle: "Понятно")
        NSApp.activate(ignoringOtherApps: true); alert.runModal()
    }
}
