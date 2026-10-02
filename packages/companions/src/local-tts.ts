import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { speechBudget } from "./speech-budget.js";
import type { DiagnosticSink } from "./diagnostic-log.js";
import { discardLocalAudio, localAudio, localAudioPath } from "./local-tts-audio.js";
import { speechStreamPolicy, type LocalSpeechAudio, type LocalSpeechRequest, type LocalSpeechStreamObserver } from "./speech-stream.js";

export type { LocalSpeechAudio, LocalSpeechRequest } from "./speech-stream.js";
interface Options {
  python?: string; worker?: string; audioDirectory?: string; log?: (message: string) => void;
  startupTimeoutMs?: number; requestTimeoutMs?: number; diagnostic?: DiagnosticSink;
}
interface PendingBase { reject: (error: Error) => void; timer?: NodeJS.Timeout; maxDuration: number; directory: string }
interface LegacyPending extends PendingBase { mode: "legacy"; resolve: (audio: LocalSpeechAudio) => void; receiving?: boolean }
interface StreamPending extends PendingBase {
  mode: "stream"; resolve: () => void; observer: LocalSpeechStreamObserver; started: boolean; ended: boolean;
  index: number; duration: number; sampleRate?: number; validation: Promise<void>; unsubscribe: () => void;
}
type Pending = LegacyPending | StreamPending;
interface IssuedChunk { duration: number; child: ChildProcessWithoutNullStreams; path: string }
const root = fileURLToPath(new URL("../../../", import.meta.url));
const frameLimit = 128 * 1024;

/** One lazily loaded MLX model serves every character; speech text never enters diagnostics. */
export class LocalTts {
  private readonly python: string;
  private readonly worker: string;
  private audioDirectory = "";
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private startupTimer?: NodeJS.Timeout;
  private readonly pending = new Map<string, Pending>();
  private readonly issued = new Map<string, Map<number, IssuedChunk>>();
  private readonly retired = new Map<string, string>();
  private buffer: Buffer = Buffer.alloc(0);
  private ready = false;
  private workerStartedAt = 0;
  private disposed = false;
  private listeningForExit = false;
  private readonly ownedDirectories = new Map<string, ChildProcessWithoutNullStreams | undefined>();
  private readonly onExit = (): void => {
    this.dispose();
    // Node does not run asynchronous filesystem cleanup after an exit listener returns.
    for (const directory of this.ownedDirectories.keys()) {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* Best effort at process exit. */ }
    }
  };

  constructor(private readonly options: Options = {}) {
    this.python = options.python ?? join(root, ".local/tts/.venv/bin/python");
    this.worker = options.worker ?? join(root, "packages/companions/tts/worker.py");
  }

  async synthesize(request: LocalSpeechRequest): Promise<LocalSpeechAudio> {
    if (this.disposed) throw new Error("Local speech worker is closed");
    const encoded = JSON.stringify(request) + "\n";
    if (!request.id || request.id.length > 128 || Buffer.byteLength(encoded) > 64 * 1024) {
      throw new Error("Invalid local speech request");
    }
    const maxDuration = speechBudget(request.text).seconds;
    await this.start();
    if (this.disposed) throw new Error("Local speech worker is closed");
    if (!this.child || !this.ready) throw new Error("Local speech worker is unavailable");
    if (this.pending.has(request.id)) throw new Error("Duplicate local speech request identifier");
    if (this.pending.size >= 16) throw new Error("Local speech queue is full");
    const child = this.child;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => this.fail("Local speech generation timed out", true, "request-timeout"), this.options.requestTimeoutMs ?? 120_000);
      this.pending.set(request.id, { mode: "legacy", resolve: resolveRequest, reject, timer, maxDuration, directory: this.audioDirectory });
      child.stdin.write(encoded, error => { if (error && this.child === child) this.fail("Local speech input channel failed", true, "input-failed"); });
    });
  }

  /** Keep one text generation incremental; only playback completion releases its credits. */
  async stream(request: LocalSpeechRequest, observer: LocalSpeechStreamObserver, signal?: AbortSignal): Promise<void> {
    const encoded = JSON.stringify({ ...request, type: "synthesize", stream: true }) + "\n";
    if (!request.id || request.id.length > 128 || Buffer.byteLength(encoded) > 64 * 1024) throw new Error("Invalid local speech request");
    if (signal?.aborted) throw new Error("Local speech generation cancelled");
    let unsubscribe = () => {};
    try {
      await Promise.race([this.start(), new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error("Local speech generation cancelled"));
        signal?.addEventListener("abort", abort, { once: true });
        unsubscribe = () => signal?.removeEventListener("abort", abort);
      })]);
    } finally { unsubscribe(); }
    if (signal?.aborted) throw new Error("Local speech generation cancelled");
    if (this.disposed) throw new Error("Local speech worker is closed");
    if (!this.child || !this.ready) throw new Error("Local speech worker is unavailable");
    if (this.pending.has(request.id) || this.issued.has(request.id) || this.retired.has(request.id)) throw new Error("Duplicate local speech request identifier");
    if (this.pending.size >= 16) throw new Error("Local speech queue is full");
    return new Promise<void>((resolveRequest, reject) => {
      const abort = () => this.rejectStream(request.id, new Error("Local speech generation cancelled"));
      const pending: StreamPending = { mode: "stream", resolve: resolveRequest, reject, directory: this.audioDirectory,
        maxDuration: speechBudget(request.text).seconds, observer, started: false, ended: false,
        index: 0, duration: 0, validation: Promise.resolve(), unsubscribe: () => signal?.removeEventListener("abort", abort) };
      this.pending.set(request.id, pending);
      signal?.addEventListener("abort", abort, { once: true });
      this.write(encoded);
    });
  }

  consumed(id: string, index: number): void {
    const chunks = this.issued.get(id), issued = chunks?.get(index);
    if (!issued) return;
    chunks!.delete(index);
    if (!chunks!.size) this.issued.delete(id);
    if (issued.child === this.child) this.write(JSON.stringify({ type: "consume", id, index }) + "\n");
  }

  private write(encoded: string): void {
    const child = this.child;
    if (!child || !this.ready) return;
    child.stdin.write(encoded, error => { if (error && this.child === child) this.fail("Local speech input channel failed", true, "input-failed"); });
  }

  private retire(id: string, directory: string): void {
    this.retired.set(id, directory);
    while (this.retired.size > 512) this.retired.delete(this.retired.keys().next().value!);
  }

  private rejectStream(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending || pending.mode !== "stream") return;
    clearTimeout(pending.timer); pending.unsubscribe(); this.pending.delete(id);
    this.retire(id, pending.directory);
    this.write(JSON.stringify({ type: "cancel", id }) + "\n");
    pending.reject(error);
  }

  private streamTimer(pending: StreamPending, blocked = false): void {
    clearTimeout(pending.timer); pending.timer = undefined;
    if (!blocked) pending.timer = setTimeout(() => this.fail("Local speech generation timed out", true, "request-timeout"), this.options.requestTimeoutMs ?? 120_000);
  }

  private start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Local speech worker is closed"));
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    // LaunchServices gives the player its own TCC identity: runtime WAVs must stay outside Documents.
    const audioDirectory = resolve(this.options.audioDirectory
      ?? join(homedir(), "Library", "Caches", "CodexBridge", "audio", `${process.pid}-${randomUUID()}`));
    mkdirSync(audioDirectory, { recursive: true, mode: 0o700 });
    this.audioDirectory = audioDirectory;
    this.starting = new Promise<void>((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady; this.rejectReady = rejectReady;
    });
    const started = this.starting;
    const child = spawn(this.python, ["-u", this.worker], { cwd: root, stdio: "pipe",
      env: { ...process.env, CODEXBRIDGE_TTS_AUDIO_DIR: audioDirectory } });
    if (!this.options.audioDirectory) this.ownedDirectories.set(audioDirectory, child);
    const startedAt = Date.now();
    this.child = child; this.buffer = Buffer.alloc(0); this.workerStartedAt = startedAt;
    this.options.diagnostic?.("worker-start", { pid: child.pid });
    this.startupTimer = setTimeout(() => this.fail("Local speech model startup timed out", true, "startup-timeout"), this.options.startupTimeoutMs ?? 90_000);
    child.stderr.resume();
    child.stdout.on("data", (data: Buffer) => {
      if (this.child === child) this.receive(data);
    });
    child.once("error", () => { if (this.child === child) this.fail("Local speech worker could not start", true, "spawn-failed"); });
    child.stdin.on("error", () => { if (this.child === child) this.fail("Local speech input channel failed", true, "input-failed"); });
    child.once("close", code => {
      this.options.diagnostic?.("worker-exit", { code, reason: this.disposed ? "disposed" : "exited", elapsedMs: Date.now() - startedAt });
      if (this.child === child) this.fail("Local speech worker exited", true, "exited");
      if (!this.options.audioDirectory) {
        // Delivered WAVs belong to the playback queue, which can outlive this worker.
        this.ownedDirectories.set(audioDirectory, undefined);
        if (this.disposed) this.cleanDirectory(audioDirectory);
      }
    });
    if (!this.listeningForExit) {
      process.once("exit", this.onExit); this.listeningForExit = true;
    }
    return started;
  }

  private receive(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    let end: number;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      if (end > frameLimit) { this.fail("Local speech output exceeded its frame limit", true, "frame-limit"); return; }
      const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
      if (!line.length) continue;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(line.toString("utf8"));
        if (!value || typeof value !== "object") throw new Error();
      } catch { this.fail("Local speech worker returned invalid output", true, "invalid-output"); return; }
      if (value.type === "ready" && !this.ready) {
        this.ready = true; clearTimeout(this.startupTimer); this.resolveReady?.();
        this.options.diagnostic?.("worker-ready", { elapsedMs: Date.now() - this.workerStartedAt });
        this.resolveReady = undefined; this.rejectReady = undefined;
      } else if (typeof value.id === "string" && this.pending.get(value.id)?.mode === "stream") {
        this.receiveStream(value.id, value, this.pending.get(value.id) as StreamPending);
      } else if (typeof value.id === "string" && this.retired.has(value.id)) {
        if (value.type === "audio-chunk") void this.discardLate(value.id, value, this.retired.get(value.id)!);
      } else if (value.type === "audio" && typeof value.id === "string" && this.pending.get(value.id)?.mode === "legacy") {
        const pending = this.pending.get(value.id)! as LegacyPending;
        if (pending.receiving) { this.fail("Local speech worker returned a duplicate response", true, "duplicate-response"); return; }
        pending.receiving = true;
        void this.completeAudio(value.id, value);
      } else if (value.type === "error" && typeof value.id === "string" && this.pending.has(value.id)) {
        const pending = this.pending.get(value.id)!;
        clearTimeout(pending.timer); this.pending.delete(value.id);
        this.options.diagnostic?.("worker-error", { audioId: value.id, reason: "synthesis-failed" });
        pending.reject(new Error("Local speech generation failed"));
      } else {
        this.fail("Local speech worker returned an unexpected response", true, "unexpected-response"); return;
      }
    }
    if (this.buffer.length > frameLimit) this.fail("Local speech output exceeded its frame limit", true, "frame-limit");
  }

  private receiveStream(id: string, value: Record<string, unknown>, pending: StreamPending): void {
    if (value.type === "stream-start" && !pending.started) {
      pending.started = true; this.streamTimer(pending);
      try { pending.observer.start?.(); } catch { this.rejectStream(id, new Error("Local speech observer failed")); }
    } else if (value.type === "stream-blocked" && pending.started && !pending.ended && typeof value.blocked === "boolean") {
      this.streamTimer(pending, value.blocked);
    } else if (value.type === "audio-chunk" && pending.started && !pending.ended && value.index === pending.index) {
      pending.index += 1; this.streamTimer(pending);
      pending.validation = pending.validation.then(() => this.completeChunk(id, value, pending));
    } else if (value.type === "stream-end" && pending.started && !pending.ended && value.chunks === pending.index && pending.index > 0) {
      pending.ended = true; clearTimeout(pending.timer);
      pending.validation = pending.validation.then(() => {
        if (this.pending.get(id) !== pending) return;
        pending.unsubscribe(); this.pending.delete(id); this.retire(id, pending.directory); pending.resolve();
      });
    } else if (value.type === "error" || value.type === "stream-cancelled") {
      this.options.diagnostic?.("worker-error", { audioId: id, reason: "synthesis-failed" });
      this.rejectStream(id, new Error("Local speech generation failed"));
    } else {
      if (value.type === "audio-chunk" || value.type === "audio") void this.discardLate(id, value, pending.directory);
      this.fail("Local speech worker returned an invalid stream sequence", true, "unexpected-response");
    }
  }

  private async discardLate(id: string, value: Record<string, unknown>, directory: string): Promise<void> {
    try {
      const path = await localAudioPath(directory, value.path);
      const issued = [...this.issued.values()].some(chunks => [...chunks.values()].some(chunk => chunk.path === path));
      if (!issued) await unlink(path).catch(() => undefined);
    } catch { /* Missing or outside this worker's cache. */ }
    // Duplicate delivery must not release a buffer still owned by the native player.
    if (!this.issued.get(id)?.has(value.index as number) && Number.isInteger(value.index) && (value.index as number) >= 0) {
      this.write(JSON.stringify({ type: "consume", id, index: value.index }) + "\n");
    }
  }

  private async completeChunk(id: string, value: Record<string, unknown>, pending: StreamPending): Promise<void> {
    if (this.pending.get(id) !== pending) { await this.discardLate(id, value, pending.directory); return; }
    let audio: LocalSpeechAudio;
    try { audio = await localAudio(pending.directory, value); }
    catch {
      await this.discardLate(id, value, pending.directory);
      if (this.pending.get(id) === pending) this.fail("Local speech worker returned an invalid audio file", true, "invalid-audio");
      return;
    }
    if (this.pending.get(id) !== pending) { await this.discardLate(id, value, pending.directory); return; }
    const buffered = [...this.issued.values()].flatMap(chunks => [...chunks.values()]).reduce((sum, chunk) => sum + chunk.duration, 0);
    if (audio.duration > 2.08 + 1e-9 || pending.duration + audio.duration > pending.maxDuration + 1e-9 ||
        buffered + audio.duration > speechStreamPolicy.maxBufferedSeconds + 1e-9 ||
        (pending.sampleRate !== undefined && pending.sampleRate !== audio.sampleRate)) {
      await discardLocalAudio(pending.directory, audio.path);
      this.fail("Local speech stream exceeded its audio budget", true, "invalid-audio");
      return;
    }
    pending.duration += audio.duration; pending.sampleRate = audio.sampleRate;
    const chunks = this.issued.get(id) ?? new Map<number, IssuedChunk>(), index = value.index as number;
    chunks.set(index, { ...audio, child: this.child! }); this.issued.set(id, chunks);
    try { pending.observer.chunk({ ...audio, index }); }
    catch {
      this.consumed(id, index); await discardLocalAudio(pending.directory, audio.path);
      this.rejectStream(id, new Error("Local speech observer failed"));
    }
  }

  private async completeAudio(id: string, value: Record<string, unknown>): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || pending.mode !== "legacy") return;
    let audio: LocalSpeechAudio;
    try {
      audio = await localAudio(pending.directory, value);
    } catch {
      if (this.pending.get(id) === pending) this.fail("Local speech worker returned an invalid audio file", true, "invalid-audio");
      return;
    }
    if (this.pending.get(id) !== pending) { await unlink(audio.path).catch(() => undefined); return; }
    if (audio.duration > pending.maxDuration) {
      clearTimeout(pending.timer); this.pending.delete(id);
      await unlink(audio.path).catch(() => undefined);
      this.options.diagnostic?.("worker-error", { audioId: id, reason: "over-duration", durationMs: audio.duration * 1000 });
      pending.reject(new Error("Local speech exceeded its duration budget"));
      return;
    }
    clearTimeout(pending.timer); this.pending.delete(id); pending.resolve(audio);
  }

  private fail(message: string, report = true, reason = "invalid-output"): void {
    if (report) this.options.diagnostic?.("worker-error", { reason, pending: this.pending.size });
    const error = new Error(message);
    this.rejectReady?.(error); this.resolveReady = undefined; this.rejectReady = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.mode === "stream") { pending.unsubscribe(); this.retire(id, pending.directory); }
      pending.reject(error);
    }
    this.pending.clear(); this.stop();
    if (report) {
      try { this.options.log?.(message); } catch { /* Diagnostics cannot disrupt the parent session. */ }
    }
  }

  private stop(): void {
    clearTimeout(this.startupTimer);
    const child = this.child;
    this.child = undefined; this.starting = undefined; this.ready = false; this.buffer = Buffer.alloc(0);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // Do not load another model until the previous worker has actually exited.
    let closed!: () => void;
    const stopping = new Promise<void>(resolve => { closed = resolve; });
    this.stopping = stopping;
    let killTimer: NodeJS.Timeout | undefined;
    child.once("close", () => {
      clearTimeout(killTimer);
      if (this.stopping === stopping) this.stopping = undefined;
      closed();
    });
    child.stdin.end(); child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1500); killTimer.unref();
  }

  /** Discard failed preparation; the next request starts one fresh worker after exit. */
  async reset(): Promise<void> {
    if (this.disposed) return;
    this.fail("Local speech worker reset", false);
    await this.stopping;
  }

  private cleanDirectory(directory: string): void {
    void rm(directory, { recursive: true, force: true }).then(() => {
      this.ownedDirectories.delete(directory);
    }).catch(() => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.fail("Local speech worker is closed", false);
    process.removeListener("exit", this.onExit); this.listeningForExit = false;
    for (const [directory, child] of this.ownedDirectories) {
      if (!child) this.cleanDirectory(directory);
    }
  }
}
