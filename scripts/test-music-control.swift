import AppKit

/// Compile-time capture fixture: exercises the real controller without opening any microphone.
@MainActor final class MusicCapture {
    static var instance: MusicCapture?
    var onBeat: ((MusicBeatState) -> Void)?, onState: ((Bool) -> Void)?, onError: ((String, String) -> Void)?
    var starts = 0, stops = 0
    init() { Self.instance = self }
    func start() { starts += 1; onState?(true) }
    func stop() { stops += 1; onState?(false) }
}

@main struct MusicControlTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        let suite = "dev.codexbridge.music-tests.\(UUID())", defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let controller = MusicControl(defaults: defaults), capture = MusicCapture.instance!
        controller.configure(allowed: true)
        precondition(capture.starts == 0 && controller.menuItem.state == .off, "Music must be off by default")
        NSApp.sendAction(controller.menuItem.action!, to: controller.menuItem.target, from: controller.menuItem)
        precondition(capture.starts == 1 && controller.listening)
        precondition(defaults.bool(forKey: "companions.musicEnabled"))
        controller.setDictating(true); precondition(!controller.listening, "Dictation did not release music's microphone")
        controller.setDictating(false); precondition(capture.starts == 2 && controller.listening)
        controller.disableMicrophone(); precondition(!controller.listening)
        precondition(!defaults.bool(forKey: "companions.musicEnabled"), "Explicit global disable retained a latent microphone opt-in")
        controller.setDictating(false); precondition(capture.starts == 2, "Global dictation disable was bypassed")
        controller.configure(allowed: true); precondition(capture.starts == 2, "Re-enabling dictation must not reopen the microphone")
        NSApp.sendAction(controller.menuItem.action!, to: controller.menuItem.target, from: controller.menuItem)
        precondition(capture.starts == 3)
        controller.stop(); controller.setDictating(false)
        precondition(!controller.listening && capture.starts == 3, "Shutdown resumed capture through a late dictation callback")
        print("PASS music off by default, explicit menu opt-in, dictation handoff, persistent global microphone disable, re-enable remains manual and shutdown without reopening capture")
    }
}
