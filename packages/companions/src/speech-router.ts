import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { CompanionConfig, Role } from "./config.js";
import type { CompanionEvent } from "./director.js";
import type { NativeEvent } from "./native-host.js";
import type { DiagnosticSink } from "./diagnostic-log.js";
import type { SpeechReason, SpeechStatus } from "./speech-status.js";

export interface SpeechGenerator {
  synthesize(request: { id: string; text: string; voice: string; instructions?: string }): Promise<{ path: string; duration: number; sampleRate: number }>;
  dispose(): void;
  reset?(): Promise<void>;
}
interface Utterance {
  id: string; characterId: string; text: string; role: Role; voice: string;
  reply: { systemOnly: boolean; reason?: SpeechReason };
  taskId?: string; playbackAt?: number;
  audio?: { path: string; duration: number; sampleRate: number };
  systemRetried?: boolean; started?: boolean;
}
export interface SpeechActivity {
  changed(pending: Set<string>, speaker?: string): void;
  voiceFor(characterId: string, role: Role): string;
  status?(value: SpeechStatus): void;
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

/** One model prepares one utterance ahead while a single native player speaks. */
export class SpeechRouter {
  private queue: Utterance[] = [];
  private active?: Utterance;
  private preparing?: Utterance;
  private captions = new Set<string>();
  private muted = false;
  private suspended = false;
  private closed = false;
  private fallbackUntil = 0;
  private watchdog?: NodeJS.Timeout;
  private waiting?: { entry: Utterance; timer: NodeJS.Timeout };
  private lastPlaybackAt?: number;
  private failure?: SpeechReason;
  private notice?: SpeechReason;
  private recovering = false;
  private lastStatus = "";
  constructor(private config: CompanionConfig, private generator: SpeechGenerator,
    private send: (event: object) => void, private log: (message: string) => void,
    private removeAudio: (path: string) => Promise<unknown> = path => unlink(path).catch(() => undefined),
    private activity?: SpeechActivity, private diagnostic?: DiagnosticSink) { this.publishStatus(); }

  event(event: CompanionEvent): void {
    if (this.closed) return;
    if (event.type === "stop" || (event.type === "remove" && !(event as CompanionEvent & { visualOnly?: boolean }).visualOnly)) {
      this.clearCaptions(event.characterId); this.cancel(event.characterId, event.type === "remove" ? "retired" : "stopped");
    }
    if (this.closed) return;
    if (event.type !== "speak") { this.send(event); return; }
    if (!event.text) return;
    // Public captions must not wait for a model, audio playback, or an enabled speaker.
    this.captions.add(event.characterId);
    this.send({ type: "caption", characterId: event.characterId, text: event.text });
    if (this.closed || this.muted || this.suspended) return;
    const chunks = speechChunks(event.text);
    if (this.queue.length + chunks.length > 32) { this.notice = "queue-full"; this.publishStatus(); this.diagnostic?.("speech-cancel", { characterId: event.characterId, reason: "queue-full", pending: this.queue.length }); this.log("Очередь озвучки заполнена; полный ответ остаётся в терминале."); return; }
    const role = event.role ?? "coordinator";
    const voice = this.activity?.voiceFor(event.characterId, role) ?? event.voice ?? this.config.tts.voices[role];
    const reply = { systemOnly: false };
    this.notice = undefined;
    this.queue.push(...chunks.map(text => ({ id: randomUUID(), characterId: event.characterId,
      text, role, voice, reply, taskId: event.taskId })));
    this.notify();
    this.pump();
  }

  receive(event: NativeEvent): void {
    if (this.closed) return;
    if (event.type === "speech-control") {
      if (event.action === "recover") { void this.restore(); return; }
      const characterId = this.active?.characterId;
      if (event.action === "mute") this.muted = event.muted === true;
      if (event.action === "suspend") this.suspended = event.suspended === true;
      if (event.action === "stop" || this.muted || this.suspended) this.cancel(undefined, this.muted ? "muted" : this.suspended ? "suspended" : "stopped");
      if (event.action === "stop") { this.clearCaptions(); this.notice = "stopped"; }
      // The native Stop may cross an already generated play command in the two IPC directions.
      if (event.action === "stop" && characterId) this.send({ type: "stop", characterId });
      this.publishStatus();
    } else if (event.type === "audio-started" && this.active && this.active.id === event.id && !this.active.started) {
      this.active.started = true; this.active.playbackAt = Date.now();
      if (this.active.audio || this.failure === "system-unavailable") this.failure = undefined;
      this.publishStatus();
      this.diagnostic?.("speech-start", { characterId: this.active.characterId, taskId: this.active.taskId, audioId: this.active.id,
        role: this.active.role, voice: this.active.voice, engine: this.active.audio ? "local" : "macos" });
      if (!this.active.audio) this.watchSystem(this.active, 120_000);
    } else if (event.type === "audio-finished" && this.active && this.active.id === event.id) {
      this.diagnostic?.("speech-end", { characterId: this.active.characterId, taskId: this.active.taskId, audioId: this.active.id,
        phase: event.phase, elapsedMs: this.active.playbackAt === undefined ? undefined : Date.now() - this.active.playbackAt });
      if (event.phase === "error" || (event.phase === "cancel" && !this.active.audio)) {
        this.recover(this.active, event.phase === "error" ? "playback-error" : "playback-cancel"); return;
      }
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

  private pump(): void {
    const next = this.queue[0];
    const fallback = Date.now() < this.fallbackUntil;
    if (this.waiting && (this.closed || this.muted || this.suspended || this.active ||
        this.waiting.entry !== next || next?.audio || next?.reply.systemOnly || fallback)) this.clearWaiting();
    if (this.closed || this.muted || this.suspended || this.recovering || !next) return;
    if (!this.active && (next.audio || next.reply.systemOnly || fallback || this.config.tts.engine === "macos")) {
      this.queue.shift(); this.active = next; this.notify();
      if (next.audio) this.play(next);
      else this.speakFallback(next);
      // A synchronous host failure may dispose us from inside send().
      if (this.closed || this.active !== next) return;
    }
    const upcoming = this.queue[0];
    if (!this.preparing && upcoming && !upcoming.audio && !upcoming.reply.systemOnly && !fallback && this.config.tts.engine === "local") {
      void this.prepare(upcoming);
    }
    if (!this.closed && !this.active && this.queue[0] === next && !this.waiting) this.waitForAudio(next);
  }

  /** Bound audible silence, not background prefetch; a fresh speech block can warm the model. */
  private waitForAudio(entry: Utterance): void {
    const continuing = this.lastPlaybackAt !== undefined && Date.now() - this.lastPlaybackAt < 30_000;
    const waitMs = continuing ? 4_000 : 20_000;
    this.diagnostic?.("synthesis-wait", { characterId: entry.characterId, taskId: entry.taskId, audioId: entry.id, waitMs });
    const timer = setTimeout(() => {
      if (this.waiting?.entry !== entry) return;
      this.clearWaiting();
      if (this.closed || this.muted || this.suspended || this.active || this.queue[0] !== entry) return;
      this.failure = "local-slow"; this.useSystemVoice(entry, "local-slow");
      this.diagnostic?.("speech-fallback", { characterId: entry.characterId, taskId: entry.taskId, audioId: entry.id, reason: "latency-budget", waitMs });
      this.log("Локальный голос не успел подготовить реплику. Озвучиваю её голосом macOS без дальнейшего ожидания.");
      this.pump();
    }, waitMs);
    timer.unref(); this.waiting = { entry, timer };
  }

  private clearWaiting(): void {
    clearTimeout(this.waiting?.timer); this.waiting = undefined;
  }

  private async prepare(entry: Utterance): Promise<void> {
    this.preparing = entry;
    this.publishStatus();
    const started = Date.now();
    this.diagnostic?.("synthesis-start", { characterId: entry.characterId, taskId: entry.taskId, audioId: entry.id, role: entry.role, voice: entry.voice });
    try {
      const audio = await this.generator.synthesize({ id: entry.id, text: entry.text,
        voice: entry.voice, instructions: directions[entry.role] });
      if (this.closed || entry.reply.systemOnly || !this.queue.includes(entry)) {
        this.diagnostic?.("synthesis-discard", { characterId: entry.characterId, audioId: entry.id, reason: "stale-audio", elapsedMs: Date.now() - started });
        await this.removeAudio(audio.path); return;
      }
      this.diagnostic?.("synthesis-end", { characterId: entry.characterId, taskId: entry.taskId, audioId: entry.id,
        elapsedMs: Date.now() - started, durationMs: audio.duration * 1000 });
      entry.audio = audio;
    } catch {
      this.diagnostic?.("synthesis-end", { characterId: entry.characterId, audioId: entry.id, reason: "synthesis-failed", elapsedMs: Date.now() - started });
      if (!this.closed && this.queue.includes(entry)) {
        this.failure = "local-unavailable";
        this.useSystemVoice(entry, this.failure); this.fallbackUntil = Date.now() + 30_000;
        this.log("Локальный синтезатор временно недоступен. Реплика передана голосу macOS; локальные голоса повторно проверяются через 30 секунд.");
      }
    } finally { if (this.preparing === entry) this.preparing = undefined; this.pump(); this.publishStatus(); }
  }

  private play(entry: Utterance): void {
    const audio = entry.audio!;
    this.send({ type: "play-audio", characterId: entry.characterId, role: entry.role, text: entry.text,
      audioId: entry.id, path: audio.path });
    if (this.closed || this.active !== entry) return;
    this.watchdog = setTimeout(() => {
      if (this.active === entry) this.recover(entry, "playback-timeout");
    }, (audio.duration + 10) * 1000);
    this.watchdog.unref();
  }

  private speakFallback(entry: Utterance): void {
    this.useSystemVoice(entry, entry.reply.reason ?? (Date.now() < this.fallbackUntil ? "local-unavailable" : "system-selected"));
    this.publishStatus();
    this.diagnostic?.("speech-fallback", { characterId: entry.characterId, taskId: entry.taskId, audioId: entry.id, engine: "macos", reason: Date.now() < this.fallbackUntil ? "synthesis-failed" : undefined });
    this.send({ type: "speak", characterId: entry.characterId, role: entry.role, text: entry.text, audioId: entry.id,
      ...(entry.systemRetried ? { resetVoice: true } : {}) });
    if (this.closed || this.active !== entry) return;
    this.watchSystem(entry, entry.started ? 120_000 : 15_000);
  }

  /** After a fallback, finish this public reply in one voice; the next reply may use Qwen again. */
  private useSystemVoice(entry: Utterance, reason?: SpeechReason): void {
    entry.reply.systemOnly = true;
    if (reason) entry.reply.reason = reason;
    for (const queued of this.queue) {
      if (queued.reply !== entry.reply || !queued.audio) continue;
      void this.removeAudio(queued.audio.path); queued.audio = undefined;
    }
  }

  private watchSystem(entry: Utterance, timeout: number): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => { if (this.active === entry) this.recover(entry, entry.started ? "system-timeout" : "system-no-start"); }, timeout);
    this.watchdog.unref();
  }

  /** Isolate callbacks before Stop; a silent system synthesizer gets one fresh instance. */
  private recover(entry: Utterance, reason: string): void {
    this.diagnostic?.("speech-fallback", { characterId: entry.characterId, taskId: entry.taskId, audioId: entry.id, reason: entry.systemRetried ? "system-retry-exhausted" : reason });
    clearTimeout(this.watchdog);
    if (entry.systemRetried) {
      this.failure = "system-unavailable";
      this.active = undefined;
      this.send({ type: "stop", characterId: entry.characterId });
      this.log("Не удалось восстановить системный голос; текст доступен в терминале.");
      this.complete(); return;
    }
    if (entry.audio) void this.removeAudio(entry.audio.path);
    if (entry.audio) this.failure = "playback-failed";
    const retry = { ...entry, id: randomUUID(), audio: undefined, started: false, systemRetried: !entry.audio };
    retry.reply.reason = "playback-failed";
    this.active = retry;
    this.send({ type: "stop", characterId: entry.characterId });
    if (this.closed || this.active !== retry) return;
    this.log(entry.audio ? "Не удалось воспроизвести локальный голос. Повторяю реплику голосом macOS."
      : "Системный синтезатор не завершил реплику. Перезапускаю голос и повторяю текст.");
    this.speakFallback(retry);
  }

  private complete(): void {
    clearTimeout(this.watchdog);
    if (this.active) this.lastPlaybackAt = Date.now();
    if (this.active?.audio) void this.removeAudio(this.active.audio.path);
    this.active = undefined; this.notify(); this.pump();
  }

  private cancel(characterId?: string, reason = "stopped"): void {
    this.diagnostic?.("speech-cancel", { characterId, reason, pending: this.queue.length + Number(Boolean(this.active)) });
    for (const entry of this.queue) {
      if ((characterId === undefined || entry.characterId === characterId) && entry.audio) void this.removeAudio(entry.audio.path);
    }
    this.queue = this.queue.filter(entry => characterId !== undefined && entry.characterId !== characterId);
    if (this.active && (characterId === undefined || this.active.characterId === characterId)) this.complete();
    this.notify(); this.pump();
  }

  private notify(): void {
    this.diagnostic?.("speech-queue", { characterId: this.active?.characterId, pending: this.queue.length + Number(Boolean(this.active)), preparing: Boolean(this.preparing), muted: this.muted, suspended: this.suspended });
    this.activity?.changed(new Set([...this.queue.map(entry => entry.characterId),
      ...(this.active ? [this.active.characterId] : [])]), this.active?.characterId);
    this.publishStatus();
  }

  private status(): SpeechStatus {
    const pending = this.queue.length + Number(Boolean(this.active && !this.active.started));
    let phase: SpeechStatus["phase"] = "idle";
    let reason = this.failure ?? this.notice;
    if (this.suspended) phase = "dictating";
    else if (this.muted || this.config.speech === "off") { phase = "muted"; reason = this.config.speech === "off" ? "disabled" : undefined; }
    else if (this.recovering) phase = "recovering";
    else if (this.active) {
      phase = this.active.started ? this.active.audio ? "local" : "system" : "queued";
      reason = this.active.audio ? undefined : this.active.reply.reason;
    } else if (this.queue.length) {
      phase = this.preparing && this.queue.includes(this.preparing) ? "synthesizing" : "queued";
      reason = this.queue[0]?.reply.reason;
    } else if (this.failure === "system-unavailable" || this.failure === "recovery-failed") phase = "error";
    const canRecover = Boolean(this.failure) && !this.closed && !this.recovering && !this.muted && !this.suspended
      && this.config.speech !== "off" && !this.active && !this.queue.length;
    return { phase, pending, ...(reason ? { reason } : {}), canRecover };
  }

  private publishStatus(): void {
    if (this.closed) return;
    const status = this.status(), key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key; this.activity?.status?.(status);
  }

  /** Explicit recovery resets failed engines only; no past text is retained or replayed. */
  private async restore(): Promise<void> {
    if (!this.status().canRecover) return;
    this.recovering = true; this.preparing = undefined; this.publishStatus();
    try {
      await this.generator.reset?.();
      if (this.closed) return;
      this.send({ type: "reset-speech" });
      this.fallbackUntil = 0; this.lastPlaybackAt = undefined; this.failure = undefined; this.notice = "restored";
    } catch { this.failure = "recovery-failed"; }
    finally { this.recovering = false; this.publishStatus(); this.pump(); }
  }

  private clearCaptions(characterId?: string): void {
    for (const id of [...this.captions]) {
      if (characterId !== undefined && id !== characterId) continue;
      this.captions.delete(id);
      if (!this.closed) this.send({ type: "caption", characterId: id, text: "" });
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.captions.clear(); this.cancel(undefined, "disposed"); this.generator.dispose();
  }
}
