import AppKit

struct MusicCapturePolicy {
    var enabled = false, allowed = true, dictating = false, failed = false
    var shouldCapture: Bool { enabled && allowed && !dictating && !failed }
}

/// Music opt-in is visible, persisted and subordinate to the global microphone/dictation switch.
@MainActor final class MusicControl: NSObject {
    let menuItem = NSMenuItem(title: "Реагировать на музыку", action: nil, keyEquivalent: "")
    let statusItem = NSMenuItem(title: "Музыкальный режим выключен", action: nil, keyEquivalent: "")
    var onBeat: ((MusicBeatState?) -> Void)?
    var onChange: (() -> Void)?
    var onError: ((String) -> Void)?
    var onDiagnostic: (([String: Any]) -> Void)?
    private let capture = MusicCapture()
    private let defaults: UserDefaults
    private var policy = MusicCapturePolicy()
    private var diagnostics = MusicDiagnosticGate()
    private(set) var listening = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        super.init()
        policy.enabled = defaults.bool(forKey: "companions.musicEnabled")
        menuItem.target = self; menuItem.action = #selector(toggle)
        statusItem.isEnabled = false
        capture.onState = { [weak self] active in
            guard let self else { return }
            self.listening = active
            if !active { self.onBeat?(nil) }
            self.diagnose(active ? "running" : "stopped", reason: self.policy.shouldCapture ? "active" : "disabled")
            self.updateMenu(); self.onChange?()
        }
        capture.onBeat = { [weak self] beat in
            guard let self, self.policy.shouldCapture else { return }
            self.onBeat?(beat)
            let dancing = beat.strength(at: Date.timeIntervalSinceReferenceDate) > 0.05
            self.diagnose(beat.classification == "speech" ? "speech" : dancing ? "music" : "quiet",
                          confidence: beat.classificationConfidence, tempo: dancing ? 60 / beat.period : 0)
            self.statusItem.title = dancing
                ? "Музыка · \(Int((60 / beat.period).rounded())) уд/мин" : "Микрофон включён · жду музыку и ритм"
        }
        capture.onError = { [weak self] message, reason in
            guard let self else { return }
            self.policy.failed = true; self.updateMenu(); self.onError?(message)
            self.diagnose("unavailable", reason: reason)
        }
        updateMenu()
    }

    func configure(allowed: Bool) { policy.allowed = allowed; reconcile() }
    func setDictating(_ active: Bool) { policy.dictating = active; reconcile() }
    func disableMicrophone() {
        policy.allowed = false; policy.enabled = false
        defaults.set(false, forKey: "companions.musicEnabled"); reconcile()
    }
    @objc private func toggle() {
        policy.enabled.toggle(); policy.failed = false
        defaults.set(policy.enabled, forKey: "companions.musicEnabled"); reconcile()
    }
    func stop() { policy.allowed = false; capture.stop(); onBeat?(nil) }

    private func reconcile() {
        if policy.shouldCapture {
            if !listening { diagnose("starting") }
            capture.start()
        } else { capture.stop(); onBeat?(nil) }
        updateMenu(); onChange?()
    }

    private func diagnose(_ state: String, reason: String = "active", confidence: Double = 0, tempo: Double = 0) {
        guard diagnostics.accept(state: state, tempo: tempo, at: Date.timeIntervalSinceReferenceDate) else { return }
        onDiagnostic?(["type": "diagnostic", "event": "music-state", "state": state, "reason": reason,
                       "confidence": confidence, "tempo": tempo])
    }

    private func updateMenu() {
        menuItem.state = policy.enabled ? .on : .off
        menuItem.isEnabled = policy.allowed || policy.enabled
        if !policy.enabled { statusItem.title = "Музыкальный режим выключен" }
        else if !policy.allowed { statusItem.title = "Микрофон выключен вместе с диктовкой" }
        else if policy.dictating { statusItem.title = "Музыка приостановлена на время диктовки" }
        else if policy.failed { statusItem.title = "Музыкальный режим остановлен — включи повторно" }
        else { statusItem.title = listening ? "Микрофон включён · жду музыку и ритм" : "Подключаю микрофон для музыки…" }
    }
}
