import AppKit

/// Public captions follow the active fragment across local playback, fallback and cancellation.
extension CompanionApp {
    func configureCaptionCallbacks() {
        speech.onCaptionStarted = { [weak self] id, text, key, offset in
            guard let self else { return }
            self.captions.begin(id, text: text, captionId: key, offset: offset)
            self.refreshCaption()
        }
        speech.onCaptionWord = { [weak self] id, range in
            self?.captions.word(id, range: range); self?.refreshCaption()
        }
        speech.onCaptionProgress = { [weak self] id, elapsed, duration, level in
            self?.captions.progress(id, elapsed: elapsed, duration: duration, voiced: level > 0.15)
            self?.refreshCaption()
        }
        speech.onCaptionFinished = { [weak self] id, phase in
            self?.captions.finish(id, phase: phase); self?.refreshCaption()
        }
    }

    func refreshCaption() {
        let caption = captions.presentation(visible: Set(view.characters.map(\.id)), preferred: view.speaker)
        view.bubbleOwner = caption?.characterId
        if view.bubble != (caption?.text ?? "") { view.bubble = caption?.text ?? "" }
        view.speechBubble.reveal(until: caption?.visible, word: caption?.word, reduced: view.reduced)
        view.layoutBubble(width: view.bounds.width)
    }
}
