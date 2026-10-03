import AppKit

/// Stream traffic has an audio ID instead of a character ID on every chunk.
@MainActor extension CompanionApp {
    func configureStreamCallbacks() {
        speech.onChunkAccepted = { id, index in emit(["type": "audio-chunk-accepted", "id": id, "index": index]) }
        speech.onChunkConsumed = { id, index in emit(["type": "audio-chunk-consumed", "id": id, "index": index]) }
        speech.onBuffering = { [weak self] id, buffering, seconds in
            emit(["type": "audio-buffering", "id": id, "buffering": buffering, "bufferedSeconds": seconds])
            self?.updateMenu()
        }
    }

    func receiveStream(_ value: [String: Any]) -> Bool {
        guard let type = value["type"] as? String, type.hasPrefix("audio-stream-") else { return false }
        guard let audioId = value["audioId"] as? String else { return true }
        switch type {
        case "audio-stream-start":
            if let id = value["characterId"] as? String {
                speech.startStream(characterId: id, text: value["text"] as? String ?? "", audioId: audioId,
                    captionId: value["captionId"] as? String, captionOffset: value["captionOffset"] as? Int ?? 0)
            }
        case "audio-stream-chunk":
            if let index = value["index"] as? Int, let path = value["path"] as? String,
               let duration = value["duration"] as? Double, let sampleRate = value["sampleRate"] as? Double {
                speech.appendStream(audioId: audioId, index: index, path: path, duration: duration, sampleRate: sampleRate)
            }
        case "audio-stream-end": if let chunks = value["chunks"] as? Int { speech.endStream(audioId: audioId, chunks: chunks) }
        case "audio-stream-play": speech.playStream(audioId: audioId)
        default: break
        }
        updateMenu(); return true
    }
}
