import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withDraftLock } from "./draft-lock.js";

const events = ["diagnostic-start", "log-overflow", "lifecycle-state", "lifecycle-visible", "lifecycle-remove",
  "speech-queue", "synthesis-start", "synthesis-end", "synthesis-discard", "synthesis-wait", "speech-start", "speech-end",
  "speech-fallback", "speech-cancel", "worker-start", "worker-ready", "worker-exit", "worker-error",
  "native-connect", "native-close", "native-error", "renderer-state", "music-state"] as const;
export type DiagnosticEvent = typeof events[number];
export type DiagnosticSink = (event: DiagnosticEvent, fields?: Readonly<Record<string, unknown>>) => void;
const strings: Record<string, readonly string[]> = {
  role: ["coordinator", "developer", "researcher", "reviewer", "designer", "devops", "tester"],
  state: ["idle", "working", "thinking", "waiting", "success", "error", "starting", "running", "stopped", "unavailable", "music", "speech", "quiet"],
  engine: ["local", "macos"], voice: ["Serena", "Vivian", "Sohee", "Ono_Anna", "designer-local", "devops-local", "tester-local"],
  phase: ["end", "cancel", "error", "start"],
  reason: ["latency-budget", "synthesis-failed", "playback-error", "playback-cancel", "playback-timeout", "system-no-start",
    "system-timeout", "system-retry-exhausted", "muted", "suspended", "stopped", "disposed", "replaced", "retired",
    "visual-eviction", "stale-audio", "queue-full", "startup-timeout", "request-timeout", "spawn-failed", "input-failed",
    "exited", "frame-limit", "invalid-output", "duplicate-response", "unexpected-response", "invalid-audio", "over-duration",
    "connected", "closed", "native-failed", "hidden", "empty", "active", "permission-denied", "capture-failed", "disabled"],
};
const numbers = new Set(["pending", "count", "visible", "waitMs", "elapsedMs", "durationMs", "confidence", "tempo", "pid", "code", "chunkCount", "dropped"]);
const booleans = new Set(["running", "muted", "suspended", "preparing", "hidden"]);
const identifiers = new Set(["sessionId", "taskId", "characterId", "audioId"]);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);

/** Only fixed labels, bounded numeric measurements and pseudonymous identifiers can reach disk. */
function fields(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (identifiers.has(key) && typeof item === "string" && item.length > 0 && item.length <= 4096) safe[key] = hash(item);
    else if (Object.hasOwn(strings, key) && typeof item === "string" && strings[key]!.includes(item)) safe[key] = item;
    else if (numbers.has(key) && typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= 1e12) safe[key] = Math.round(item * 1000) / 1000;
    else if (booleans.has(key) && typeof item === "boolean") safe[key] = item;
  }
  return safe;
}

/** Optional per-project JSONL diagnostics; bounded async IO cannot stall or break the audio queue. */
export class DiagnosticLog {
  readonly path: string;
  private readonly runId = randomUUID();
  private lines: string[] = [];
  private writing?: Promise<void>;
  private bytes = 0;
  private dropped = 0;
  private failed = false;
  private constructor(directory: string, private readonly maxBytes: number) { this.path = join(directory, "companions.jsonl"); }

  static async open(project: string, options: { dataRoot?: string; maxBytes?: number } = {}): Promise<DiagnosticLog> {
    const canonical = await realpath(project).catch(() => resolve(project));
    const directory = join(options.dataRoot ?? process.env.CODEXBRIDGE_DATA_DIR ?? join(homedir(), "Library", "Application Support", "CodexBridge"), "diagnostics", hash(canonical));
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    const log = new DiagnosticLog(directory, Math.max(512, options.maxBytes ?? 1024 * 1024));
    await writeFile(log.path, "", { flag: "a", mode: 0o600 }); await chmod(log.path, 0o600);
    log.bytes = (await stat(log.path)).size;
    log.record("diagnostic-start", { pid: process.pid });
    return log;
  }

  readonly record: DiagnosticSink = (event, value = {}) => {
    if (this.failed || !events.includes(event)) return;
    if (this.lines.length >= 256) { this.dropped++; return; }
    const line = JSON.stringify({ schema: 1, time: new Date().toISOString(), runId: this.runId, event, ...fields(value) }) + "\n";
    if (Buffer.byteLength(line) > this.maxBytes) { this.dropped++; return; }
    this.lines.push(line);
    this.kick();
  };

  private kick(): void {
    if (this.writing || this.failed) return;
    this.writing = this.drain().catch(() => { this.failed = true; this.lines = []; this.dropped = 0; }).finally(() => {
      this.writing = undefined;
      if (this.lines.length || this.dropped) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.lines.length || this.dropped) {
      const batch = this.lines.splice(0, 64);
      if (this.dropped) {
        batch.push(JSON.stringify({ schema: 1, time: new Date().toISOString(), runId: this.runId,
          event: "log-overflow", dropped: this.dropped }) + "\n");
        this.dropped = 0;
      }
      await withDraftLock(this.path, async () => {
        // Other OpenCode processes for this project may have appended or rotated since our last batch.
        this.bytes = await stat(this.path).then(file => file.size).catch(error => { if (error.code === "ENOENT") return 0; throw error; });
        for (const line of batch) {
          const size = Buffer.byteLength(line);
          if (this.bytes + size > this.maxBytes) {
            await rm(`${this.path}.2`, { force: true });
            await rename(`${this.path}.1`, `${this.path}.2`).catch(error => { if (error.code !== "ENOENT") throw error; });
            await rename(this.path, `${this.path}.1`).catch(error => { if (error.code !== "ENOENT") throw error; });
            this.bytes = 0;
          }
          await appendFile(this.path, line, { mode: 0o600 }); this.bytes += size;
        }
      });
    }
  }

  async flush(): Promise<void> { while (this.writing) await this.writing; }
}
