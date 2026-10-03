import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { CompanionConfig, Role } from "./config.js";
import type { CompanionEvent } from "./director.js";
import type { NativeEvent } from "./native-host.js";
import type { DiagnosticSink } from "./diagnostic-log.js";
import type { SpeechReason, SpeechStatus } from "./speech-status.js";
import { speechStreamPolicy, type LocalSpeechAudio, type LocalSpeechRequest, type StreamingSpeechGenerator } from "./speech-stream.js";
import { SpeechStreamPlayback } from "./speech-stream-playback.js";

export interface SpeechGenerator extends Partial<StreamingSpeechGenerator> {
  synthesize(request: LocalSpeechRequest): Promise<LocalSpeechAudio>;
  dispose(): void;
  reset?(): Promise<void>;
}
interface Invocation { id: string; reason?: SpeechReason }
interface Utterance {
  id: string; characterId: string; text: string; role: Role; voice: string;
  captionId: string; captionOffset: number;
  invocation: Invocation; taskId?: string; playbackAt?: number;
  audio?: LocalSpeechAudio; stream?: SpeechStreamPlayback;
  systemRetried?: boolean; started?: boolean;
}
export interface SpeechActivity {
  changed(pending: Set<string>, speaker?: string): void;
  voiceFor(characterId: string, role: Role): string;
  status?(value: SpeechStatus): void;
}
const directions: Record<Role, string> = {
  coordinator: "Warm and confident.", developer: "Bright, energetic and focused.",
  researcher: "Gentle, thoughtful and measured.", reviewer: "Clear Russian speech, calm and focused, at a natural pace.",
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

/** One native stream plays while one bounded next utterance may be prefetched. */
export class SpeechRouter {
  private queue: Utterance[] = [];
  private active?: Utterance;
  private preparing?: Utterance;
  private invocations = new Map<string, Invocation>();
  private captions = new Set<string>();
  private muted = false;
  private suspended = false;
  private closed = false;
  private watchdog?: NodeJS.Timeout;
  private waiting?: { entry: Utterance; timer: NodeJS.Timeout };
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
    if (event.type === "state") this.invocation(event);
    if (event.type === "stop" || (event.type === "remove" && !(event as CompanionEvent & { visualOnly?: boolean }).visualOnly)) {
      this.clearCaptions(event.characterId); this.cancel(event.characterId, event.type === "remove" ? "retired" : "stopped");
      if (event.type === "remove") this.invocations.delete(event.characterId);
    }
    if (this.closed) return;
    if (event.type !== "speak") { this.send(event); return; }
    if (!event.text) return;
    const chunks = speechChunks(event.text);
    const enabled = !this.muted && !this.suspended && this.config.speech !== "off";
    const full = this.queue.length + chunks.length > 32;
    const captionId = randomUUID();
    this.captions.add(event.characterId);
    this.send({ type: "caption", characterId: event.characterId, captionId, text: event.text,
      animated: enabled && !full });
    if (this.closed || !enabled) return;
    if (full) {
      this.notice = "queue-full"; this.publishStatus();
      this.diagnostic?.("speech-cancel", { characterId: event.characterId, reason: "queue-full", pending: this.queue.length });
      this.log("Очередь озвучки заполнена; полный ответ остаётся в терминале."); return;
    }
    const role = event.role ?? "coordinator";
    const voice = this.activity?.voiceFor(event.characterId, role) ?? event.voice ?? this.config.tts.voices[role];
    const invocation = this.invocation(event);
    this.notice = undefined;
    let offset = 0;
    this.queue.push(...chunks.map(text => {
      const captionOffset = event.text!.indexOf(text, offset); offset = captionOffset + text.length;
      return { id: randomUUID(), characterId: event.characterId, text, role, voice,
        captionId, captionOffset, invocation, taskId: event.taskId };
    }));
    this.notify(); this.pump();
  }

  /** Real task IDs change the lock; synthetic continuations retain their invocation. */
  private invocation(event: CompanionEvent): Invocation {
    const previous = this.invocations.get(event.characterId);
    const id = event.invocationId ?? event.taskId ?? previous?.id ?? randomUUID();
    if (previous?.id === id) return previous;
    const value = { id };
    this.invocations.delete(event.characterId); this.invocations.set(event.characterId, value);
    if (this.invocations.size > 256) this.invocations.delete(this.invocations.keys().next().value!);
    return value;
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
      if (event.action === "stop" && characterId) this.send({ type: "stop", characterId });
      this.publishStatus(); return;
    }
    const entry = this.active;
    if (entry && event.id === entry.id) {
      if (event.type === "audio-chunk-accepted" && typeof event.index === "number") {
        entry.stream?.accept(event.index); this.diagnostic?.("stream-accepted", { ...this.identity(entry), index: event.index });
      } else if (event.type === "audio-chunk-consumed" && typeof event.index === "number") {
        entry.stream?.consume(event.index); this.diagnostic?.("stream-consumed", { ...this.identity(entry), index: event.index });
      }
      else if (event.type === "audio-buffering" && entry.stream) {
        const buffering = event.buffering === true;
        if (buffering !== entry.stream.buffering) {
          clearTimeout(this.watchdog);
          if (buffering && entry.started) this.watch(entry, speechStreamPolicy.underrunWaitMs, "stream-stall");
        }
        entry.stream.buffering = buffering;
        this.diagnostic?.("stream-buffering", { ...this.identity(entry), buffering: entry.stream.buffering, bufferedSeconds: event.bufferedSeconds });
        this.publishStatus();
      } else if (event.type === "audio-started" && !entry.started) {
        entry.started = true; entry.playbackAt = Date.now(); this.clearWaiting();
        if (entry.stream) clearTimeout(this.watchdog);
        if (this.local(entry) || this.failure === "system-unavailable") this.failure = undefined;
        this.diagnostic?.("speech-start", { ...this.identity(entry), role: entry.role, voice: entry.voice, engine: this.local(entry) ? "local" : "macos" });
        if (!this.local(entry)) this.watch(entry, 120_000, "system-timeout");
        this.publishStatus();
      } else if (event.type === "audio-finished") {
        this.diagnostic?.("speech-end", { ...this.identity(entry), phase: event.phase,
          elapsedMs: entry.playbackAt === undefined ? undefined : Date.now() - entry.playbackAt });
        if (event.phase === "error" || event.phase === "cancel") { this.recover(entry, "playback-error"); return; }
        if (entry.stream) {
          entry.stream.finished = true; clearTimeout(this.watchdog);
          if (!entry.stream.done) return; // Keep the resident until both producer and player finish.
        }
        this.complete();
      }
    } else if (event.type === "test-voices") {
      const samples: [Role, string][] = [["coordinator", "Я веду задачу и собираю результаты команды."],
        ["developer", "Я пишу код. Сейчас всё соберём и проверим."], ["researcher", "Я изучаю материалы и проверяю источники."],
        ["reviewer", "Я проверяю изменения и ищу ошибки."]];
      samples.forEach(([role, text], index) => this.event({ type: "speak", characterId: `preview-${index}`, role, text }));
    }
  }

  private identity(entry: Utterance): Record<string, unknown> {
    return { characterId: entry.characterId, taskId: entry.taskId, invocationId: entry.invocation.id, audioId: entry.id };
  }
  private local(entry: Utterance): boolean { return Boolean(entry.audio || entry.stream); }
  private live(entry: Utterance): boolean { return !this.closed && (this.active === entry || this.queue.includes(entry)); }

  private pump(): void {
    if (this.closed || this.muted || this.suspended || this.recovering) return;
    const next = this.queue[0];
    if (!this.active && next && (next.audio || next.stream || next.invocation.reason || this.config.tts.engine === "macos")) {
      this.clearWaiting(); this.queue.shift(); this.active = next; this.notify();
      if (next.invocation.reason || this.config.tts.engine === "macos") this.speakFallback(next);
      else if (next.stream) { this.waitForAudio(next); next.stream.start(next.characterId, next.role, next.text, next.captionId, next.captionOffset); }
      else this.play(next);
      if (this.closed || this.active !== next) return;
    }
    const upcoming = this.queue[0];
    if (!this.preparing && upcoming && !upcoming.audio && !upcoming.stream && !upcoming.invocation.reason && this.config.tts.engine === "local") void this.prepare(upcoming);
    if (!this.active && this.queue[0] && !this.waiting) this.waitForAudio(this.queue[0]);
  }

  /** Each eligible utterance gets 20 seconds; background prefetch never spends its deadline. */
  private waitForAudio(entry: Utterance): void {
    if (this.waiting?.entry === entry) return;
    this.clearWaiting();
    const waitMs = speechStreamPolicy.startupWaitMs;
    this.diagnostic?.("synthesis-wait", { ...this.identity(entry), waitMs });
    const timer = setTimeout(() => {
      if (this.waiting?.entry !== entry) return;
      this.clearWaiting();
      if (!this.live(entry) || entry.started || this.muted || this.suspended) return;
      if (entry.stream?.count && this.active === entry) {
        this.send({ type: "audio-stream-play", audioId: entry.id });
        this.watch(entry, speechStreamPolicy.underrunWaitMs, "playback-timeout"); return;
      }
      this.failure = "local-slow"; this.lock(entry, this.failure);
      this.diagnostic?.("speech-fallback", { ...this.identity(entry), reason: "latency-budget", waitMs });
      this.log("Локальный голос не успел начать речь. До завершения этой задачи используется голос macOS.");
      if (this.active === entry) this.retrySystem(entry); else this.pump();
    }, waitMs);
    timer.unref(); this.waiting = { entry, timer };
  }
  private clearWaiting(): void { clearTimeout(this.waiting?.timer); this.waiting = undefined; }

  private async prepare(entry: Utterance): Promise<void> {
    this.preparing = entry;
    const request = { id: entry.id, text: entry.text, voice: entry.voice, instructions: directions[entry.role] };
    const started = Date.now();
    this.diagnostic?.("synthesis-start", { ...this.identity(entry), role: entry.role, voice: entry.voice });
    if (this.generator.stream) {
      entry.stream = new SpeechStreamPlayback(entry.id, this.send, this.removeAudio,
        (id, index) => this.generator.consumed?.(id, index));
    }
    this.publishStatus();
    try {
      if (entry.stream) {
        const stream = entry.stream;
        this.pump();
        await this.generator.stream!(request, { chunk: audio => {
          if (stream.chunk(audio)) {
            this.diagnostic?.("stream-chunk", { ...this.identity(entry), index: audio.index, durationMs: audio.duration * 1000 });
            this.publishStatus();
          }
        } }, stream.abort.signal);
        if (!this.live(entry) || entry.invocation.reason || stream.abort.signal.aborted) return;
        if (!stream.count) throw new Error("Empty speech stream");
        stream.done = true; stream.end();
        this.diagnostic?.("stream-ended", { ...this.identity(entry), chunks: stream.count });
        if (stream.finished && this.active === entry) this.complete();
      } else {
        const audio = await this.generator.synthesize(request);
        if (!this.live(entry) || entry.invocation.reason) {
          this.diagnostic?.("synthesis-discard", { ...this.identity(entry), reason: "stale-audio", elapsedMs: Date.now() - started });
          await this.removeAudio(audio.path); return;
        }
        entry.audio = audio;
      }
      this.diagnostic?.("synthesis-end", { ...this.identity(entry), elapsedMs: Date.now() - started,
        durationMs: (entry.audio?.duration ?? entry.stream?.duration ?? 0) * 1000 });
    } catch {
      this.diagnostic?.("synthesis-end", { ...this.identity(entry), reason: "synthesis-failed", elapsedMs: Date.now() - started });
      if (this.live(entry) && !entry.invocation.reason) {
        if (this.active === entry) this.recover(entry, "synthesis-failed");
        else {
          this.failure = "local-unavailable"; this.lock(entry, this.failure);
          this.log("Локальный синтезатор недоступен. До завершения этой задачи используется голос macOS.");
        }
      }
    } finally {
      if (this.preparing === entry) this.preparing = undefined;
      this.pump(); this.notify();
    }
  }

  private play(entry: Utterance): void {
    this.send({ type: "play-audio", characterId: entry.characterId, role: entry.role, text: entry.text,
      audioId: entry.id, path: entry.audio!.path, captionId: entry.captionId, captionOffset: entry.captionOffset });
    if (!this.closed && this.active === entry) this.watch(entry, (entry.audio!.duration + 10) * 1000, "playback-timeout");
  }
  private speakFallback(entry: Utterance): void {
    this.publishStatus();
    this.diagnostic?.("speech-fallback", { ...this.identity(entry), engine: "macos", reason: entry.invocation.reason });
    this.send({ type: "speak", characterId: entry.characterId, role: entry.role, text: entry.text, audioId: entry.id,
      captionId: entry.captionId, captionOffset: entry.captionOffset,
      ...(entry.systemRetried ? { resetVoice: true } : {}) });
    if (!this.closed && this.active === entry) this.watch(entry, 15_000, "system-no-start");
  }

  /** Lock all public messages in this agent invocation, without affecting other agents. */
  private lock(entry: Utterance, reason: SpeechReason): void {
    entry.invocation.reason = reason;
    for (const queued of this.queue) if (queued.invocation === entry.invocation) this.release(queued);
  }
  private release(entry: Utterance): void {
    entry.stream?.close(); entry.stream = undefined;
    if (entry.audio) { void this.removeAudio(entry.audio.path); entry.audio = undefined; }
  }
  private watch(entry: Utterance, timeout: number, reason: string): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => { if (this.active === entry) this.recover(entry, reason); }, timeout);
    this.watchdog.unref();
  }

  /** Once PCM was audible, preserve its caption and never repeat that fragment through another voice. */
  private recover(entry: Utterance, reason: string): void {
    const local = this.local(entry);
    this.diagnostic?.("speech-fallback", { ...this.identity(entry), reason: entry.systemRetried ? "system-retry-exhausted" : reason });
    this.clearWaiting(); clearTimeout(this.watchdog);
    if (local && entry.started) {
      this.failure = "partial-stream-failure"; this.lock(entry, this.failure);
      this.active = undefined; this.release(entry);
      this.send({ type: "stop", characterId: entry.characterId });
      this.log("Поток речи прервался. Текущий фрагмент остаётся в подписи; следующие реплики этой задачи озвучит macOS.");
      this.notify(); this.pump(); return;
    }
    if (entry.systemRetried) {
      this.failure = "system-unavailable"; this.active = undefined; this.release(entry);
      this.send({ type: "stop", characterId: entry.characterId });
      this.log("Не удалось восстановить системный голос; текст доступен в терминале.");
      this.notify(); this.pump(); return;
    }
    this.failure = reason === "synthesis-failed" ? "local-unavailable" : "playback-failed";
    this.lock(entry, this.failure);
    this.log(local ? "Не удалось начать локальную речь. Передаю реплику голосу macOS."
      : "Системный синтезатор не начал или не завершил реплику. Перезапускаю голос.");
    this.retrySystem(entry, !local);
  }
  private retrySystem(entry: Utterance, systemRetried = false): void {
    this.clearWaiting(); clearTimeout(this.watchdog); this.release(entry);
    const retry = { ...entry, id: randomUUID(), audio: undefined, stream: undefined, started: false, playbackAt: undefined, systemRetried };
    this.active = retry;
    this.send({ type: "stop", characterId: entry.characterId });
    if (!this.closed && this.active === retry) this.speakFallback(retry);
  }
  private complete(): void {
    this.clearWaiting(); clearTimeout(this.watchdog);
    if (this.active) this.release(this.active);
    this.active = undefined; this.notify(); this.pump();
  }
  private cancel(characterId?: string, reason = "stopped"): void {
    this.diagnostic?.("speech-cancel", { characterId, reason, pending: this.queue.length + Number(Boolean(this.active)) });
    for (const entry of this.queue) if (characterId === undefined || entry.characterId === characterId) this.release(entry);
    this.queue = this.queue.filter(entry => characterId !== undefined && entry.characterId !== characterId);
    if (this.waiting && (characterId === undefined || this.waiting.entry.characterId === characterId)) this.clearWaiting();
    if (this.active && (characterId === undefined || this.active.characterId === characterId)) {
      clearTimeout(this.watchdog); this.release(this.active); this.active = undefined;
    }
    this.notify(); this.pump();
  }
  private notify(): void {
    this.diagnostic?.("speech-queue", { characterId: this.active?.characterId, pending: this.queue.length + Number(Boolean(this.active)), preparing: Boolean(this.preparing), muted: this.muted, suspended: this.suspended });
    this.activity?.changed(new Set([...this.queue.map(entry => entry.characterId), ...(this.active ? [this.active.characterId] : [])]), this.active?.characterId);
    this.publishStatus();
  }
  private status(): SpeechStatus {
    const pending = this.queue.length + Number(Boolean(this.active && !this.active.started));
    const lockedReason = [...this.invocations.values()].find(invocation => invocation.reason)?.reason;
    let phase: SpeechStatus["phase"] = "idle", reason = this.failure ?? lockedReason ?? this.notice;
    if (this.suspended) phase = "dictating";
    else if (this.muted || this.config.speech === "off") { phase = "muted"; reason = this.config.speech === "off" ? "disabled" : undefined; }
    else if (this.recovering) phase = "recovering";
    else if (this.active) {
      phase = this.active.stream?.buffering ? "buffering" : this.active.started ? this.local(this.active) ? "local" : "system"
        : this.active.stream && !this.active.stream.count ? "synthesizing" : "queued";
      reason = this.local(this.active) ? undefined : this.active.invocation.reason ?? "system-selected";
    } else if (this.queue.length) {
      phase = this.preparing && this.queue.includes(this.preparing) ? "synthesizing" : "queued";
      reason = this.queue[0]?.invocation.reason;
    } else if (this.failure === "system-unavailable" || this.failure === "recovery-failed") phase = "error";
    const canRecover = Boolean(this.failure ?? lockedReason) && !this.closed && !this.recovering && !this.muted && !this.suspended
      && this.config.speech !== "off" && !this.active && !this.queue.length;
    return { phase, pending, ...(reason ? { reason } : {}), canRecover };
  }
  private publishStatus(): void {
    if (this.closed) return;
    const status = this.status(), key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key; this.activity?.status?.(status);
  }

  /** Recovery affects future speech only, leaves mute/dictation unchanged and requires an idle queue. */
  private async restore(): Promise<void> {
    if (!this.status().canRecover) return;
    this.recovering = true; this.preparing = undefined; this.publishStatus();
    try {
      await this.generator.reset?.();
      if (this.closed) return;
      this.send({ type: "reset-speech" });
      for (const invocation of this.invocations.values()) invocation.reason = undefined;
      this.failure = undefined; this.notice = "restored";
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
    this.closed = true; this.captions.clear(); this.cancel(undefined, "disposed"); this.invocations.clear(); this.generator.dispose();
  }
}
