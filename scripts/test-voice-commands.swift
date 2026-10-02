import Foundation

@main struct VoiceCommandTests {
    static func parts(_ text: String, pauses: [Int: Double] = [:]) -> [VoiceSegment] {
        let source = text as NSString
        var offset = 0, time = 0.0
        return text.components(separatedBy: " ").enumerated().map { index, word in
            let range = source.range(of: word, range: NSRange(location: offset, length: source.length - offset))
            offset = range.location + range.length
            time += pauses[index] ?? 0.05
            let segment = VoiceSegment(range: range, timestamp: time, duration: 0.25)
            time += 0.25
            return segment
        }
    }

    static func main() {
        for (phrase, command) in VoiceCommands.aliases {
            precondition(VoiceCommands.recognize("  \(phrase.uppercased())! ", segments: []) == VoiceInput(text: "", command: command))
        }
        for text in ["добавь слово отправить", "не отправляй", "не отправить", "отправь", "объясни команду отправить", "отправить письмо завтра", "отменить тесты", "sudo удалить файлы"] {
            precondition(VoiceCommands.recognize(text, segments: parts(text)) == nil, "Embedded or unknown command: \(text)")
        }
        let request = "Проверь тесты. Отправить"
        precondition(VoiceCommands.recognize(request, segments: parts(request)) == nil, "No pause must leave the text intact")
        precondition(VoiceCommands.recognize(request, segments: parts(request, pauses: [2: 1])) == VoiceInput(text: "Проверь тесты.", command: "submit"))
        let explicit = "Исправь баг. Команда отправить"
        precondition(VoiceCommands.recognize(explicit, segments: parts(explicit, pauses: [2: 1])) == VoiceInput(text: "Исправь баг.", command: "submit"))
        let cancel = "Случайный черновик отменить диктовку"
        precondition(VoiceCommands.recognize(cancel, segments: parts(cancel, pauses: [2: 1])) == VoiceInput(text: "", command: "cancel"))
        let embedded = "Добавь кнопку остановить задачу"
        precondition(VoiceCommands.recognize(embedded, segments: parts(embedded, pauses: [2: 1])) == nil)
        for text in ["Добавь слово отправить", "Не отправить", "Не надо отправить", "Создай кнопку отправить", "Не. Отправить", "Добавь слово. Отправить", "Не надо! Отправить", "Не нужно. Отправить", "Добавь слово пожалуйста. Отправить", "Не стоит пока. Отправить"] {
            let index = text.components(separatedBy: " ").count - 1
            precondition(VoiceCommands.recognize(text, segments: parts(text, pauses: [index: 1])) == nil, "A pause must not turn literal or negated text into a command")
        }
        let unicode = "Добавь 🎙 справа. Отправить"
        precondition(VoiceCommands.recognize(unicode, segments: parts(unicode, pauses: [3: 1])) == VoiceInput(text: "Добавь 🎙 справа.", command: "submit"))
        let invalid = [VoiceSegment(range: NSRange(location: 0, length: 2), timestamp: 0, duration: 1),
                       VoiceSegment(range: NSRange(location: 999, length: 2), timestamp: 3, duration: 1)]
        precondition(VoiceCommands.recognize("Нет команды", segments: invalid) == nil)
        print("PASS whole voice commands, terminal pause, negation, embedded words, cancellation and UTF-16 boundaries")
    }
}
