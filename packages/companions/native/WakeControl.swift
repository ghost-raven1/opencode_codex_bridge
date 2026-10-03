import AppKit

/// Persisted keyword opt-in follows the global microphone switch and pauses during our own speech.
@MainActor final class WakeControl: NSObject {
    let menuItem = NSMenuItem(title: "Активация по слову «OpenCode»", action: nil, keyEquivalent: "")
    let statusItem = NSMenuItem(title: "Слово пробуждения выключено", action: nil, keyEquivalent: "")
    var onChange: (() -> Void)?
    var onDiagnostic: (([String: Any]) -> Void)?
    private let dictation: NativeDictation
    private let defaults: UserDefaults
    private var allowed = false, dictating = false, speaking = false, failed = false, stopped = false
    private var language = "ru-RU", lastState = ""
    private var cooldown: Timer?
    private(set) var enabled = false

    init(dictation: NativeDictation, defaults: UserDefaults = .standard) {
        self.dictation = dictation; self.defaults = defaults
        super.init()
        menuItem.target = self; menuItem.action = #selector(toggle)
        statusItem.isEnabled = false
    }

    func configure(configured: Bool, allowed: Bool, language: String) {
        enabled = defaults.object(forKey: "companions.wakeWordEnabled") as? Bool ?? configured
        self.allowed = allowed; self.language = language; reconcile()
    }

    func update(allowed: Bool, dictating: Bool, speaking: Bool) {
        guard self.allowed != allowed || self.dictating != dictating || self.speaking != speaking else { return }
        let justFinished = self.dictating && !dictating || self.speaking && !speaking
        self.allowed = allowed; self.dictating = dictating; self.speaking = speaking
        if justFinished, enabled, allowed, !stopped { scheduleResume() }
        reconcile()
    }

    func setEnabled(_ enabled: Bool) {
        guard !enabled || allowed, !stopped else { return }
        self.enabled = enabled; failed = false
        defaults.set(enabled, forKey: "companions.wakeWordEnabled")
        if !enabled { cooldown?.invalidate(); cooldown = nil }
        reconcile(); onChange?()
    }

    func disableMicrophone() {
        allowed = false; setEnabled(false)
    }

    func captureChanged() { refresh(); onChange?() }
    func captureFailed() { failed = true; reconcile(); onChange?() }
    func triggered() { onDiagnostic?(["type": "diagnostic", "event": "wake-state", "state": "triggered", "reason": "active"]) }
    func stop() {
        stopped = true; cooldown?.invalidate(); cooldown = nil; dictation.stopListening(); refresh()
    }
    var status: [String: Any] {
        ["type": "wake-status", "enabled": enabled, "listening": dictation.listening,
         "state": state, "keyword": "OpenCode"]
    }

    @objc private func toggle() { setEnabled(!enabled) }

    private var state: String {
        if stopped || !enabled || !allowed { return "stopped" }
        if failed { return "unavailable" }
        if dictating || speaking || cooldown != nil { return "paused" }
        return dictation.listening ? "listening" : "starting"
    }

    private func scheduleResume() {
        cooldown?.invalidate()
        let timer = Timer(timeInterval: 0.8, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.cooldown = nil; self.reconcile(); self.onChange?()
            }
        }
        cooldown = timer; RunLoop.main.add(timer, forMode: .common)
    }

    private func reconcile() {
        if enabled && allowed && !dictating && !speaking && !failed && !stopped && cooldown == nil {
            dictation.listen(language: language)
        } else { dictation.stopListening() }
        refresh()
    }

    private func refresh() {
        menuItem.state = enabled ? .on : .off; menuItem.isEnabled = allowed || enabled
        let current = state
        let titles = ["stopped": "Слово пробуждения выключено", "unavailable": "Слово пробуждения недоступно — включи повторно",
                      "starting": "Подключаю микрофон для «OpenCode»…", "listening": "Микрофон включён · жду «OpenCode»",
                      "paused": dictating ? "Диктовка запроса · затем скажи «Отправить»" : "«OpenCode» на паузе до окончания озвучки"]
        statusItem.title = titles[current]!
        guard current != lastState else { return }
        lastState = current
        onDiagnostic?(["type": "diagnostic", "event": "wake-state", "state": current,
            "reason": failed ? "capture-failed" : speaking ? "speaking" : dictating ? "dictating" : cooldown != nil ? "cooldown" : enabled && allowed ? "active" : "disabled"])
    }
}
