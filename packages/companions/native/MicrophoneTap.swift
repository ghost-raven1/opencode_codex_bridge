import AVFoundation

/// Music and speech capture use the same checked tap API on new macOS versions.
enum MicrophoneTap {
    static func install(on input: AVAudioInputNode, format: AVAudioFormat, receive: @escaping AVAudioNodeTapBlock) throws {
#if compiler(>=6.4)
        if #available(macOS 27.0, *) {
            try input.__installTap(onBus: 0, bufferSize: 1024, format: format, error: (), block: receive)
        } else { input.installTap(onBus: 0, bufferSize: 1024, format: format, block: receive) }
#else
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: receive)
#endif
    }
}
