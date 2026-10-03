import Foundation

struct VoiceInput: Equatable {
    let text: String
    let command: String
}

struct VoiceSegment {
    let range: NSRange
    let timestamp: TimeInterval
    let duration: TimeInterval
}

/// Commands require a whole utterance, or a separated final submit/cancel phrase.
enum VoiceCommands {
    static let pause: TimeInterval = 0.85
    static let aliases: [String: String] = [
        "отправить": "submit", "команда отправить": "submit",
        "очистить ввод": "clear", "очисти ввод": "clear",
        "отменить диктовку": "cancel", "отмени диктовку": "cancel",
        "остановить речь": "stop-speech", "останови речь": "stop-speech",
        "остановить задачу": "stop-task", "останови задачу": "stop-task",
        "скрыть компаньонов": "hide", "скрой компаньонов": "hide",
        "показать компаньонов": "show", "покажи компаньонов": "show",
        "новая задача": "new-task", "новая сессия": "new-task",
        "выключить голос": "mute", "включить голос": "unmute",
        "выключить диктовку": "disable-dictation",
        "помощь по голосу": "help", "голосовые команды": "help",
    ]
    static let help = """
    Нажми кнопку микрофона 🎙, надиктуй текст, сделай паузу около секунды и скажи «Отправить».
    Повторное нажатие завершает диктовку и только вставляет текст. Без команды «Отправить» запрос модели не отправляется.

    Для старта без кнопки включи ✦ → Активация по слову «OpenCode» или введи /voice-wake-on в CLI.
    Скажи «OpenCode», затем запрос. Слово пробуждения не попадёт в текст. На время озвучки персонажей прослушивание приостанавливается.
    /voice-wake-off выключает фоновое прослушивание; кнопка микрофона продолжает работать.

    Отдельные команды:
    • «Очистить ввод» — очистить строку OpenCode.
    • «Отменить диктовку» — отбросить текущую запись.
    • «Остановить речь» / «Остановить задачу».
    • «Выключить голос» / «Включить голос».
    • «Скрыть компаньонов» / «Показать компаньонов».
    • «Новая задача» — открыть новую сессию.
    • «Выключить диктовку» — убрать кнопку и отключить запись до включения в меню ✦.
    • «Помощь по голосу» — эта справка.

    Команда в середине предложения, например «добавь слово отправить», остаётся текстом. Для отмены после текста сделай паузу и скажи «Отменить диктовку».
    """

    static func normalized(_ text: String) -> String {
        text.lowercased().replacingOccurrences(of: "ё", with: "е")
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// A quoted command or a negation at the end of a draft is ordinary text even after a pause.
    static func blocksTerminalCommand(after prefix: String) -> Bool {
        let literalCue: Set<Substring> = ["слово", "слова", "словом", "фразу", "фраза", "команду", "команды", "кнопку", "кнопка", "не", "нельзя"]
        return normalized(prefix).split(separator: " ").suffix(3).contains { literalCue.contains($0) }
    }

    static func recognize(_ text: String, segments: [VoiceSegment]) -> VoiceInput? {
        if let command = aliases[normalized(text)] { return VoiceInput(text: "", command: command) }
        let source = text as NSString
        for index in segments.indices.dropFirst() {
            let segment = segments[index], previous = segments[index - 1]
            guard segment.range.location > 0, segment.range.location < source.length,
                  segment.timestamp - previous.timestamp - previous.duration >= pause,
                  let command = aliases[normalized(source.substring(from: segment.range.location))],
                  command == "submit" || command == "cancel" else { continue }
            let prefix = source.substring(to: segment.range.location).trimmingCharacters(in: .whitespacesAndNewlines)
            // A pause before a quoted word or negated verb is still ordinary dictation.
            if blocksTerminalCommand(after: prefix) { continue }
            return VoiceInput(text: command == "cancel" ? "" : prefix, command: command)
        }
        return nil
    }
}
