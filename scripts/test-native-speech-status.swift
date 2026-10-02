import AppKit

@main struct NativeSpeechStatusTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        let status = NativeSpeechStatus(), menu = NSMenu()
        var requested = 0
        status.attach(to: menu) { requested += 1 }
        precondition(status.summary.title.contains("нет готовой реплики") && status.summary.title.contains("ожидает: 0"))
        precondition(!status.recovery.isEnabled)
        for (phase, text) in [("synthesizing", "готовим"), ("queued", "ждём"), ("local", "локальный"), ("system", "резерв macOS"), ("buffering", "буферизация")] {
            status.receive(["phase": phase, "pending": 2, "reason": "SECRET RAW TEXT", "canRecover": true])
            precondition(status.summary.title.contains(text) && status.summary.title.contains("ожидает: 2"))
            precondition(!status.recovery.isEnabled && !status.detail.title.contains("SECRET"))
        }
        status.receive(["phase": "system", "pending": 0, "reason": "system-selected", "canRecover": false])
        precondition(status.summary.title.contains("говорит голос macOS"))
        status.receive(["phase": "system", "pending": 1, "reason": "partial-stream-failure", "canRecover": false])
        precondition(status.detail.title.contains("не повторяется") && status.detail.title.contains("следующие фрагменты"))
        status.receive(["phase": "error", "pending": 0, "reason": "system-unavailable", "canRecover": true])
        precondition(status.recovery.isEnabled && status.detail.title.contains("не ответил"))
        status.update(muted: false, suspended: false, playback: "local")
        status.requestRecovery(); precondition(requested == 0 && !status.recovery.isEnabled)
        status.update(muted: true, suspended: false, playback: nil)
        status.requestRecovery(); precondition(requested == 0 && status.summary.title.contains("выключен"))
        status.update(muted: false, suspended: true, playback: nil)
        status.requestRecovery(); precondition(requested == 0 && status.summary.title.contains("диктовку"))
        status.update(muted: false, suspended: false, playback: nil)
        status.requestRecovery(); status.requestRecovery()
        precondition(requested == 1 && status.summary.title.contains("восстанавливаем"))
        precondition(status.recovery.title.contains("следующих реплик"))
        status.receive(["phase": "idle", "pending": 0, "reason": "restored", "canRecover": false])
        precondition(!status.recovery.isEnabled && status.detail.title.contains("прежние не повторяются"))
        status.receive(["phase": "SECRET", "pending": 0, "reason": "SECRET"])
        precondition(!status.summary.title.contains("SECRET") && !status.detail.title.contains("SECRET"))
        print("PASS voice menu phases/counts, fixed explanations, guarded one-shot recovery, mute/dictation, no raw text and future-only recovery")
    }
}
