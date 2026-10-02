import AppKit

@MainActor extension CompanionApp {
    func configureMusic() {
        music.onBeat = { [weak self] beat in self?.view.musicBeat = beat }
        music.onChange = { [weak self] in self?.updateMenu() }
        music.onError = { message in emit(["type": "error", "code": "music", "message": message]) }
        music.onDiagnostic = { emit($0) }
        music.configure(allowed: dictationEnabled)
    }

    func emitRendererState(previous: Bool) {
        guard previous != (timer != nil) else { return }
        emit(["type": "diagnostic", "event": "renderer-state", "state": timer != nil ? "running" : "stopped",
              "running": timer != nil, "hidden": windowState.hidden, "count": view.characters.count,
              "reason": timer != nil ? "active" : windowState.hidden ? "hidden" : "empty"])
    }

    func updateMusicIndicator() {
        guard music.listening, !dictation.active else { return }
        microphoneItem?.button?.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "Музыкальный режим: микрофон включён")
        microphoneItem?.button?.contentTintColor = .systemOrange
        microphoneItem?.button?.toolTip = "Микрофон слушает музыку. Нажми для диктовки; отключить реакцию можно в меню ✦."
    }
}
