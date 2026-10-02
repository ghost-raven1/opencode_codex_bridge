import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { realpath, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { speechBudget } from "./speech-budget.js";

export interface LocalSpeechRequest { id: string; text: string; voice: string; instructions?: string }
export interface LocalSpeechAudio { path: string; duration: number; sampleRate: number }
interface Options {
  python?: string; worker?: string; audioDirectory?: string; log?: (message: string) => void;
  startupTimeoutMs?: number; requestTimeoutMs?: number;
}
interface Pending {
  resolve: (audio: LocalSpeechAudio) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
  maxDuration: number;
  receiving?: boolean;
}
const root = fileURLToPath(new URL("../../../", import.meta.url));
const frameLimit = 128 * 1024;

/** One lazily loaded MLX model serves every character; speech text never enters diagnostics. */
export class LocalTts {
  private readonly python: string;
  private readonly worker: string;
  private audioDirectory = "";
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private startupTimer?: NodeJS.Timeout;
  private readonly pending = new Map<string, Pending>();
  private buffer: Buffer = Buffer.alloc(0);
  private ready = false;
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
      const timer = setTimeout(() => this.fail("Local speech generation timed out"), this.options.requestTimeoutMs ?? 120_000);
      this.pending.set(request.id, { resolve: resolveRequest, reject, timer, maxDuration });
      child.stdin.write(encoded, error => { if (error && this.child === child) this.fail("Local speech input channel failed"); });
    });
  }

  private start(): Promise<void> {
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
    this.child = child; this.buffer = Buffer.alloc(0);
    this.startupTimer = setTimeout(() => this.fail("Local speech model startup timed out"), this.options.startupTimeoutMs ?? 90_000);
    child.stderr.resume();
    child.stdout.on("data", (data: Buffer) => {
      if (this.child === child) this.receive(data);
    });
    child.once("error", () => { if (this.child === child) this.fail("Local speech worker could not start"); });
    child.stdin.on("error", () => { if (this.child === child) this.fail("Local speech input channel failed"); });
    child.once("close", () => {
      if (this.child === child) this.fail("Local speech worker exited");
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
      if (end > frameLimit) { this.fail("Local speech output exceeded its frame limit"); return; }
      const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
      if (!line.length) continue;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(line.toString("utf8"));
        if (!value || typeof value !== "object") throw new Error();
      } catch { this.fail("Local speech worker returned invalid output"); return; }
      if (value.type === "ready" && !this.ready) {
        this.ready = true; clearTimeout(this.startupTimer); this.resolveReady?.();
        this.resolveReady = undefined; this.rejectReady = undefined;
      } else if (value.type === "audio" && typeof value.id === "string" && this.pending.has(value.id)) {
        const pending = this.pending.get(value.id)!;
        if (pending.receiving) { this.fail("Local speech worker returned a duplicate response"); return; }
        pending.receiving = true;
        void this.completeAudio(value.id, value);
      } else if (value.type === "error" && typeof value.id === "string" && this.pending.has(value.id)) {
        const pending = this.pending.get(value.id)!;
        clearTimeout(pending.timer); this.pending.delete(value.id);
        pending.reject(new Error("Local speech generation failed"));
      } else {
        this.fail("Local speech worker returned an unexpected response"); return;
      }
    }
    if (this.buffer.length > frameLimit) this.fail("Local speech output exceeded its frame limit");
  }

  private async completeAudio(id: string, value: Record<string, unknown>): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;
    let audio: LocalSpeechAudio;
    try {
      if (typeof value.path !== "string" || !isAbsolute(value.path) || !value.path.endsWith(".wav") ||
          typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 180 ||
          typeof value.sampleRate !== "number" || !Number.isInteger(value.sampleRate) || value.sampleRate < 8000 || value.sampleRate > 96000) {
        throw new Error();
      }
      const [directory, path] = await Promise.all([realpath(this.audioDirectory), realpath(value.path)]);
      const inside = relative(directory, path);
      if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error();
      const file = await stat(path);
      if (!file.isFile() || file.size <= 44 || file.size > 32 * 1024 * 1024) throw new Error();
      audio = { path, duration: value.duration, sampleRate: value.sampleRate };
    } catch {
      if (this.pending.get(id) === pending) this.fail("Local speech worker returned an invalid audio file");
      return;
    }
    if (this.pending.get(id) !== pending) { await unlink(audio.path).catch(() => undefined); return; }
    if (audio.duration > pending.maxDuration) {
      clearTimeout(pending.timer); this.pending.delete(id);
      await unlink(audio.path).catch(() => undefined);
      pending.reject(new Error("Local speech exceeded its duration budget"));
      return;
    }
    clearTimeout(pending.timer); this.pending.delete(id); pending.resolve(audio);
  }

  private fail(message: string, report = true): void {
    const error = new Error(message);
    this.rejectReady?.(error); this.resolveReady = undefined; this.rejectReady = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.stop();
    if (report) {
      try { this.options.log?.(message); } catch { /* Diagnostics cannot disrupt the parent session. */ }
    }
  }

  private stop(): void {
    clearTimeout(this.startupTimer);
    const child = this.child;
    this.child = undefined; this.starting = undefined; this.ready = false; this.buffer = Buffer.alloc(0);
    if (!child) return;
    child.stdin.end(); child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 1500); killTimer.unref();
    child.once("close", () => clearTimeout(killTimer));
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
