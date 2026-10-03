import Foundation

@main struct CaptionStateTests {
    static func main() {
        var captions = CaptionState()
        let first = "Проверка 👩🏽‍💻. Проверка 👩🏽‍💻. Готово."
        captions.update("code", text: first, captionId: "first", animated: true)
        captions.begin("code", text: "Проверка 👩🏽‍💻.", captionId: "first", offset: 0)
        captions.word("code", range: NSRange(location: 0, length: 8))
        let opening = captions.presentation(visible: ["code"])!
        precondition(opening.visible == 8 && opening.text == first)
        captions.update("code", text: "Следующий ответ", captionId: "next", animated: true)
        precondition(captions.text(visible: ["code"]) == first, "Queued messages replaced playing speech")
        captions.finish("code", phase: "end")
        precondition(captions.text(visible: ["code"]) == first, "Inter-fragment pause replaced the active caption")
        let offset = ("Проверка 👩🏽‍💻. " as NSString).length
        captions.begin("code", text: "Проверка 👩🏽‍💻.", captionId: "first", offset: offset)
        captions.word("code", range: NSRange(location: 0, length: 8))
        precondition(captions.presentation(visible: ["code"])!.visible == offset + 8, "Repeated fragment restarted the caption")
        captions.word("other", range: NSRange(location: 0, length: 99))
        captions.word("code", range: NSRange(location: 1000, length: 99))
        precondition(captions.presentation(visible: ["code"])!.visible == offset + 8)
        captions.update("code", text: "")
        captions.progress("code", elapsed: 10, duration: 10, voiced: true)
        precondition(captions.text(visible: ["code"]).isEmpty, "Late playback resurrected a cancelled caption")

        let text = "Первое слово, второе слово и последнее."
        captions.update("review", text: text, captionId: "pcm", animated: true)
        captions.begin("review", text: text, captionId: "pcm", offset: 0)
        captions.progress("review", elapsed: 0.1, duration: 8, voiced: true)
        let early = captions.presentation(visible: ["review"])!.visible!
        precondition(early > 0 && early < (text as NSString).length)
        captions.progress("review", elapsed: 5, duration: 8, voiced: false)
        precondition(captions.presentation(visible: ["review"])!.visible == early, "Silent/buffering audio advanced text")
        captions.progress("review", elapsed: 3, duration: 8, voiced: true)
        let middle = captions.presentation(visible: ["review"])!.visible!
        captions.progress("review", elapsed: 1, duration: 15, voiced: true)
        precondition(captions.presentation(visible: ["review"])!.visible == middle, "Duration correction rewound words")
        captions.finish("review", phase: "end")
        precondition(captions.presentation(visible: ["review"])!.visible == (text as NSString).length)
        captions.update("review", text: text, captionId: "cancelled", animated: true)
        captions.begin("review", text: "Первое слово,", captionId: "cancelled", offset: 0)
        captions.word("review", range: NSRange(location: 0, length: 6))
        captions.finish("review", phase: "cancel")
        precondition(captions.presentation(visible: ["review"])!.visible == nil, "A failed stream hid the remaining public text")
        captions.update("review", text: "Новый ответ без звука", captionId: "muted")
        precondition(captions.text(visible: ["review"]) == "Новый ответ без звука", "Cancelled speech blocked a later muted caption")
        captions.begin("review", text: "Первое слово,", captionId: "pcm", offset: 0)
        captions.finish("review", phase: "end")
        captions.update("review", text: "Текст после отключения речи", captionId: "off")
        precondition(captions.text(visible: ["review"]) == "Текст после отключения речи", "An inactive fragment blocked a non-animated caption")
        var reveal = SpeechReveal(text: text)
        precondition(reveal.advance(elapsed: 100, duration: nil, voiced: true).0 < (text as NSString).length)
        for i in 0..<150 { captions.update("agent-\(i)", text: "Ответ", captionId: "caption-\(i)") }
        precondition(captions.text(visible: ["agent-149"]) == "Ответ" && captions.text(visible: ["agent-0"]).isEmpty)
        print("PASS queued caption identity, repeated Unicode fragments, PCM timing, pauses, cancellation and bounded history")
    }
}
