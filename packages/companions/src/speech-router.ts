import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { CompanionConfig, Role } from "./config.js";
import type { CompanionEvent } from "./director.js";
import type { NativeEvent } from "./native-host.js";

export interface SpeechGenerator {
  synthesize(request: { id: string; text: string; voice: string; instructions?: string }): Promise<{ path: string; duration: number; sampleRate: number }>;
  dispose(): void;
}
interface Utterance { id: string; characterId: string; text: string; role: Role; voice?: string; path?: string }
export interface SpeechActivity {
  changed(pending: Set<string>, speaker?: string): void;
  voiceFor(characterId: string, role: Role): string;
}
const directions: Record<Role, string> = {
  coordinator: "Warm and confident.",
  developer: "Bright, energetic and focused.",
  researcher: "Gentle, thoughtful and measured.",
  reviewer: "Calm, firm and deliberate.",
};

/** Short sentence groups keep local synthesis responsive without losing the rest of an answer. */
export function speechChunks(text: string, limit = 320): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const prefix = rest.slice(0, limit);
    const sentence = [...prefix.matchAll(/[.!?…](?:\s|$)/g)].at(-1);
    const boundary = sentence && sentence.index! > limit / 3 ? sentence.index! + 1 : prefix.lastIndexOf(" ");
    const end = boundary > 0 ? boundary : limit;
    chunks.push(rest.slice(0, end).trim()); rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Serialize generation and playback across roles; cancelled generations can never resume speaking. */
export class SpeechRouter {
  private queue: Utterance[] = [];
  private active?: Utterance;
  private generating = false;
  private muted = false;
  private suspended = false;
  private closed = false;
  private fallback = false;
  private watchdog?: NodeJS.Timeout;
  constructor(private config: CompanionConfig, private generator: SpeechGenerator,
    private send: (event: object) => void, private log: (message: string) => void,
    private removeAudio: (path: string) => Promise<unknown> = path => unlink(path).catch(() => undefined),
    private activity?: SpeechActivity) {}

  event(event: CompanionEvent): void {
    if (this.closed) return;
    if (event.type === "stop" || (event.type === "remove" && !(event as CompanionEvent & { visualOnly?: boolean }).visualOnly)) this.cancel(event.characterId);
    if (event.type !== "speak") { this.send(event); return; }
    if (this.muted || this.suspended || !event.text) return;
    const chunks = speechChunks(event.text);
    if (this.queue.length + chunks.length > 32) { this.log("Очередь озвучки заполнена; полный ответ остаётся в терминале."); return; }
    this.queue.push(...chunks.map(text => ({ id: randomUUID(), characterId: event.characterId,
      text, role: event.role ?? "coordinator" as Role, voice: event.voice })));
    this.notify();
    void this.pump();
  }

  receive(event: NativeEvent): void {
    if (this.closed) return;
    if (event.type === "speech-control") {
      const characterId = this.active?.characterId;
      if (event.action === "mute") this.muted = event.muted === true;
      if (event.action === "suspend") this.suspended = event.suspended === true;
      if (event.action === "stop" || this.muted || this.suspended) this.cancel();
      // The native Stop may cross an already generated play command in the two IPC directions.
      if (event.action === "stop" && characterId) this.send({ type: "stop", characterId });
    } else if (event.type === "audio-finished" && this.active?.id === event.id) {
      if (event.phase === "error") this.log("Не удалось воспроизвести локальный голос; текст доступен в терминале.");
      this.complete();
    } else if (event.type === "test-voices") {
      const samples: [Role, string][] = [["coordinator", "Я веду задачу и собираю результаты команды."],
        ["developer", "Я пишу код. Сейчас всё соберём и проверим."],
        ["researcher", "Я изучаю материалы и проверяю источники."],
        ["reviewer", "Я проверяю изменения и ищу ошибки."]];
      samples.forEach(([role, text], index) => {
        this.event({ type: "speak", characterId: `preview-${index}`, role, text });
      });
    }
  }

  private async pump(): Promise<void> {
    if (this.closed || this.generating || this.active || this.muted || this.suspended) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.active = entry;
    this.notify();
    if (this.fallback || this.config.tts.engine === "macos") { this.speakFallback(entry); return; }
    this.generating = true;
    try {
      const audio = await this.generator.synthesize({ id: entry.id, text: entry.text,
        voice: this.activity?.voiceFor(entry.characterId, entry.role) ?? entry.voice ?? this.config.tts.voices[entry.role], instructions: directions[entry.role] });
      if (this.closed || this.active !== entry) { await this.removeAudio(audio.path); return; }
      entry.path = audio.path;
      this.send({ type: "play-audio", characterId: entry.characterId, role: entry.role, text: entry.text,
        audioId: entry.id, path: audio.path });
      if (this.closed || this.active !== entry) return;
      this.watchdog = setTimeout(() => {
        this.send({ type: "stop", characterId: entry.characterId }); this.complete();
      }, (audio.duration + 10) * 1000);
      this.watchdog.unref();
    } catch {
      if (!this.closed && this.active === entry) {
        this.fallback = true;
        this.log("Локальный синтезатор недоступен. До перезапуска используется голос macOS.");
        this.speakFallback(entry);
      }
    } finally { this.generating = false; void this.pump(); }
  }

  private speakFallback(entry: Utterance): void {
    this.send({ type: "speak", characterId: entry.characterId, role: entry.role, text: entry.text, audioId: entry.id });
    if (this.closed || this.active !== entry) return;
    this.watchdog = setTimeout(() => {
      this.send({ type: "stop", characterId: entry.characterId }); this.complete();
    }, 120_000);
    this.watchdog.unref();
  }

  private complete(): void {
    clearTimeout(this.watchdog);
    if (this.active?.path) void this.removeAudio(this.active.path);
    this.active = undefined; this.notify(); void this.pump();
  }

  private cancel(characterId?: string): void {
    this.queue = this.queue.filter(entry => characterId !== undefined && entry.characterId !== characterId);
    if (this.active && (characterId === undefined || this.active.characterId === characterId)) this.complete();
    this.notify();
  }

  private notify(): void {
    this.activity?.changed(new Set([...this.queue.map(entry => entry.characterId),
      ...(this.active ? [this.active.characterId] : [])]), this.active?.characterId);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.cancel(); this.generator.dispose();
  }
}
