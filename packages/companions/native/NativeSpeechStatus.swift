import AppKit

/// A text-free voice indicator. Recovery changes future playback and never replays old words.
@MainActor final class NativeSpeechStatus: NSObject {
    let summary = NSMenuItem(title: "Озвучка: нет готовой реплики · ожидает: 0", action: nil, keyEquivalent: "")
    let detail = NSMenuItem(title: "Озвучим следующий готовый текст.", action: nil, keyEquivalent: "")
    let recovery = NSMenuItem(title: "Восстановить голос для следующих реплик", action: nil, keyEquivalent: "")
    private var phase = "idle", reason = ""
    private var pending = 0, eligible = false, muted = false, suspended = false, requested = false
    private var playback: String?
    private var onRecover: (() -> Void)?
    private var localVoice = true
    private let titles = ["idle": "нет готовой реплики", "synthesizing": "готовим голос", "queued": "ждём воспроизведения",
                          "local": "говорит локальный голос", "system": "говорит резерв macOS", "muted": "голос выключен",
                          "dictating": "пауза на диктовку", "buffering": "буферизация", "error": "голос недоступен", "recovering": "восстанавливаем голос"]
    private let explanations = ["local-unavailable": "Локальный голос не ответил; используем голос macOS.",
        "local-slow": "Подготовка заняла слишком долго; используем голос macOS.",
        "playback-failed": "Звук не воспроизвёлся; пробуем голос macOS.",
        "partial-stream-failure": "Часть фразы уже прозвучала и не повторяется; следующие фрагменты озвучит macOS.",
        "system-unavailable": "Голос macOS не ответил. Текст доступен в терминале.",
        "system-selected": "Выбран системный голос macOS.", "restored": "Готово для следующих реплик; прежние не повторяются.",
        "recovery-failed": "Восстановление не завершилось. Можно попробовать ещё раз.",
        "stopped": "Озвучка остановлена; прежние реплики не повторяются.",
        "queue-full": "Очередь заполнена; пропущенный текст доступен в терминале.", "disabled": "Озвучка отключена в настройках сборки."]

    func attach(to menu: NSMenu, localVoice: Bool = true, onRecover: @escaping () -> Void) {
        self.onRecover = onRecover; self.localVoice = localVoice
        summary.isEnabled = false; detail.isEnabled = false
        recovery.target = self; recovery.action = #selector(requestRecovery)
        recovery.toolTip = "Не повторяет старый текст, не меняет диктовку или разрешения."
        for item in [summary, detail, recovery] { menu.addItem(item) }
        menu.addItem(.separator()); refresh()
    }

    func receive(_ value: [String: Any]) {
        guard let phase = value["phase"] as? String, titles[phase] != nil else { return }
        self.phase = phase; pending = min(64, max(0, value["pending"] as? Int ?? 0))
        let candidate = value["reason"] as? String ?? ""
        reason = explanations[candidate] == nil ? "" : candidate
        eligible = value["canRecover"] as? Bool ?? false; requested = false
        refresh()
    }

    func update(muted: Bool, suspended: Bool, playback: String?) {
        self.muted = muted; self.suspended = suspended; self.playback = playback
        refresh()
    }

    @objc func requestRecovery() {
        guard recovery.isEnabled, playback == nil, !muted, !suspended, !requested else { return }
        requested = true; refresh(); onRecover?()
    }

    private func refresh() {
        let visible = suspended ? "dictating" : muted ? "muted" : requested ? "recovering" : playback ?? phase
        let title = visible == "system" && (!localVoice || reason == "system-selected") ? "говорит голос macOS" : titles[visible] ?? titles["idle"]!
        let waiting = max(pending, playback == "queued" ? 1 : 0)
        summary.title = "Озвучка: \(title) · ожидает: \(waiting)"
        if visible == "dictating" { detail.title = "После диктовки озвучим только новые реплики." }
        else if visible == "muted" { detail.title = reason == "disabled" ? explanations["disabled"]! : "Включи голос в меню, чтобы слышать новые реплики." }
        else if visible == "recovering" { detail.title = "Восстанавливаем для следующих реплик; прежние не повторяются." }
        else if let explanation = explanations[reason] { detail.title = explanation }
        else { detail.title = ["synthesizing": "Звук ещё готовится.", "buffering": "Ждём продолжение тем же голосом.", "queued": "Готовые фрагменты ждут воспроизведения.",
                               "local": "Воспроизведение началось.", "system": "Воспроизведение началось."][visible] ?? "Озвучим следующий готовый текст." }
        recovery.isEnabled = eligible && pending == 0 && playback == nil && !muted && !suspended && !requested && ["idle", "error"].contains(phase)
    }
}
