import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface LocalSpeechRequest { id: string; text: string; voice: string; instructions?: string }
export interface LocalSpeechAudio { path: string; duration: number; sampleRate: number }
interface Options {
  python?: string; worker?: string; audioDirectory?: string; log?: (message: string) => void;
  startupTimeoutMs?: number; requestTimeoutMs?: number;
}
interface Pending {
  resolve: (audio: LocalSpeechAudio) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
  receiving?: boolean;
}
const root = fileURLToPath(new URL("../../../", import.meta.url));
const frameLimit = 128 * 1024;

/** One lazily loaded MLX model serves every character; speech text never enters diagnostics. */
export class LocalTts {
  private readonly python: string;
  private readonly worker: string;
  private readonly audioDirectory: string;
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private startupTimer?: NodeJS.Timeout;
  private readonly pending = new Map<string, Pending>();
  private buffer: Buffer = Buffer.alloc(0);
  private ready = false;
  private disposed = false;
  private readonly onExit = (): void => this.dispose();

  constructor(private readonly options: Options = {}) {
    this.python = options.python ?? join(root, ".local/tts/.venv/bin/python");
    this.worker = options.worker ?? join(root, "packages/companions/tts/worker.py");
    this.audioDirectory = resolve(options.audioDirectory ?? join(root, ".local/tts/audio"));
  }

  async synthesize(request: LocalSpeechRequest): Promise<LocalSpeechAudio> {
    if (this.disposed) throw new Error("Local speech worker is closed");
    const encoded = JSON.stringify(request) + "\n";
    if (!request.id || request.id.length > 128 || Buffer.byteLength(encoded) > 64 * 1024) {
      throw new Error("Invalid local speech request");
    }
    await this.start();
    if (this.disposed) throw new Error("Local speech worker is closed");
    if (!this.child || !this.ready) throw new Error("Local speech worker is unavailable");
    if (this.pending.has(request.id)) throw new Error("Duplicate local speech request identifier");
    if (this.pending.size >= 16) throw new Error("Local speech queue is full");
    const child = this.child;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => this.fail("Local speech generation timed out"), this.options.requestTimeoutMs ?? 120_000);
      this.pending.set(request.id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(encoded, error => { if (error && this.child === child) this.fail("Local speech input channel failed"); });
    });
  }

  private start(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady; this.rejectReady = rejectReady;
    });
    const started = this.starting;
    const child = spawn(this.python, ["-u", this.worker], { cwd: root, stdio: "pipe" });
    this.child = child; this.buffer = Buffer.alloc(0);
    this.startupTimer = setTimeout(() => this.fail("Local speech model startup timed out"), this.options.startupTimeoutMs ?? 90_000);
    child.stderr.resume();
    child.stdout.on("data", (data: Buffer) => {
      if (this.child === child) this.receive(data);
    });
    child.once("error", () => { if (this.child === child) this.fail("Local speech worker could not start"); });
    child.stdin.on("error", () => { if (this.child === child) this.fail("Local speech input channel failed"); });
    child.once("close", () => { if (this.child === child) this.fail("Local speech worker exited"); });
    process.once("exit", this.onExit);
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
    clearTimeout(this.startupTimer); process.removeListener("exit", this.onExit);
    const child = this.child;
    this.child = undefined; this.starting = undefined; this.ready = false; this.buffer = Buffer.alloc(0);
    if (!child) return;
    child.stdin.end(); child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 1500); killTimer.unref();
    child.once("close", () => clearTimeout(killTimer));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.fail("Local speech worker is closed", false);
  }
}
