import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, mkdir, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const home = vi.hoisted(() => ({ directory: "" }));
vi.mock("node:os", async original => ({ ...await original<object>(), homedir: () => home.directory }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rm: vi.fn(fs.rm), stat: vi.fn(fs.stat) };
});
import { LocalTts } from "../packages/companions/src/local-tts.js";
import { configSchema } from "../packages/companions/src/config.js";
import { SpeechRouter } from "../packages/companions/src/speech-router.js";

const instances: LocalTts[] = [];
const directories: string[] = [];
beforeEach(async () => {
  vi.mocked(rm).mockClear();
  home.directory = await mkdtemp(join(tmpdir(), "codexbridge-tts-home-")); directories.push(home.directory);
});
afterEach(async () => {
  instances.splice(0).forEach(instance => instance.dispose());
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(options: { startupHang?: boolean; requestTimeoutMs?: number; startupTimeoutMs?: number; defaultAudio?: boolean; duration?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "codexbridge-tts-")); directories.push(directory);
  const audioDirectory = join(directory, "audio"), worker = join(directory, "worker.py");
  const launches = join(directory, "launches"), outside = join(directory, "outside.wav");
  await mkdir(audioDirectory); await writeFile(outside, Buffer.alloc(100));
  await writeFile(worker, `import json, os, sys, time, wave
from pathlib import Path
directory = Path(os.environ["CODEXBRIDGE_TTS_AUDIO_DIR"])
outside = Path(${JSON.stringify(outside)})
with open(${JSON.stringify(launches)}, "a") as file: file.write("start\\n")
if ${options.startupHang ? "True" : "False"}: time.sleep(30)
print(json.dumps({"type":"ready"}), flush=True)
for line in sys.stdin:
 request=json.loads(line)
 mode=request["voice"]
 if mode == "hang": time.sleep(30)
 if mode == "crash": sys.exit(2)
 if mode == "large": print("x" * (128*1024+1), flush=True); continue
 if mode == "invalid": print("invalid SECRET request text", flush=True); continue
 if mode == "error": print(json.dumps({"type":"error", "id":request["id"], "message":request["text"]}), flush=True); continue
 if mode == "limit": print(json.dumps({"type":"error", "id":request["id"], "code":"speech-limit"}), flush=True); continue
 path=directory / ("голос-" + request["id"] + ".wav")
 duration=${options.duration ?? 0.01}
 with wave.open(str(path), "wb") as file:
  file.setnchannels(1); file.setsampwidth(2); file.setframerate(24000); file.writeframes(bytes(int(duration*24000)*2))
 if mode == "escape": path=outside
 if mode == "symlink":
  path.unlink(); path.symlink_to(outside)
 result=json.dumps({"type":"audio", "id":request["id"], "path":str(path), "duration":duration, "sampleRate":24000}, ensure_ascii=False).encode("utf8")
 split=result.find("голос".encode("utf8"))+1
 sys.stdout.buffer.write(result[:split]); sys.stdout.buffer.flush()
 sys.stdout.buffer.write(result[split:]+b"\\n"); sys.stdout.buffer.flush()
`);
  const logs: string[] = [];
  const tts = new LocalTts({ python: "python3", worker, ...(options.defaultAudio ? {} : { audioDirectory }), log: message => logs.push(message),
    startupTimeoutMs: options.startupTimeoutMs ?? 2000, requestTimeoutMs: options.requestTimeoutMs ?? 2000 });
  instances.push(tts);
  return { tts, launches, outside, logs, audioDirectory };
}

const request = (id: string, voice = "ok") => ({ id, text: "SECRET request text", voice });
// Worker close rejects requests before its asynchronous cleanup finishes.
const finishRemovals = () => Promise.all(vi.mocked(rm).mock.results.map(result => result.value));
describe("local speech worker channel", () => {
  it("rejects and deletes 45 seconds for 32 characters, while allowing normal short and long speech", async () => {
    const text = "Публичная короткая фраза".padEnd(32, ".");
    const short = await fixture({ duration: 4 });
    await expect(short.tts.synthesize({ id: "short", text, voice: "ok" })).resolves.toMatchObject({ duration: 4 });
    const long = await fixture({ duration: 45 });
    await expect(long.tts.synthesize({ id: "overrun", text, voice: "ok" })).rejects.toThrow("duration budget");
    await expect(access(join(long.audioDirectory, "голос-overrun.wav"))).rejects.toThrow();
    await expect(long.tts.synthesize({ id: "long", text: "Проверю русский текст и документацию. ".repeat(10).slice(0, 320), voice: "ok" }))
      .resolves.toMatchObject({ duration: 45 });
    expect((await readFile(long.launches, "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it.each(["ok", "limit"])("routes %s overrun rejection to full macOS speech without playing a truncated WAV", async voice => {
    const f = await fixture({ duration: 45 }), send = vi.fn();
    const router = new SpeechRouter(configSchema.parse({ tts: { engine: "local" } }), f.tts, send, () => {});
    const text = "Публичная короткая фраза".padEnd(32, ".");
    try {
      router.event({ type: "speak", characterId: "agent", voice, text });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "speak", characterId: "agent", text })));
      expect(send.mock.calls.some(([event]) => event.type === "play-audio")).toBe(false);
      expect(send).toHaveBeenCalledWith({ type: "caption", characterId: "agent", text });
      expect(await readdir(f.audioDirectory)).toEqual([]);
    } finally { router.dispose(); }
  });
  it("keeps default runtime audio outside the project and isolates cleanup between workers", async () => {
    const a = await fixture({ defaultAudio: true }), b = await fixture({ defaultAudio: true });
    const [first, second] = await Promise.all([a.tts.synthesize(request("one")), b.tts.synthesize(request("two"))]);
    const cache = await realpath(join(home.directory, "Library", "Caches", "CodexBridge", "audio"));
    expect(first.path.startsWith(cache + "/")).toBe(true);
    expect(second.path.startsWith(cache + "/")).toBe(true);
    expect(dirname(first.path)).not.toBe(dirname(second.path));
    expect((await stat(dirname(first.path))).mode & 0o777).toBe(0o700);
    a.tts.dispose();
    await vi.waitFor(async () => { await expect(access(dirname(first.path))).rejects.toThrow(); });
    await expect(access(second.path)).resolves.toBeUndefined();
  });
  it("preserves delivered audio across worker failure and restart, then cleans both runs on disposal", async () => {
    const f = await fixture({ defaultAudio: true }), previous = await f.tts.synthesize(request("one"));
    await expect(f.tts.synthesize(request("bad", "large"))).rejects.toThrow("frame limit");
    const next = await f.tts.synthesize(request("two"));
    expect(dirname(next.path)).not.toBe(dirname(previous.path));
    await expect(access(previous.path)).resolves.toBeUndefined();
    await expect(access(next.path)).resolves.toBeUndefined();
    f.tts.dispose();
    await vi.waitFor(async () => {
      await expect(access(dirname(previous.path))).rejects.toThrow();
      await expect(access(dirname(next.path))).rejects.toThrow();
    });
  });
  it("plays prefetched audio after its real worker exits and removes it only after playback", async () => {
    const f = await fixture({ defaultAudio: true }), send = vi.fn();
    const ready: Awaited<ReturnType<LocalTts["synthesize"]>>[] = [];
    const router = new SpeechRouter(configSchema.parse({ tts: { engine: "local" } }), {
      synthesize: async request => { const audio = await f.tts.synthesize(request); ready.push(audio); return audio; },
      dispose: () => f.tts.dispose(),
    }, send, () => {});
    try {
      for (const characterId of ["a", "b"]) router.event({ type: "speak", characterId, text: "Публичная реплика." });
      await vi.waitFor(() => expect(ready).toHaveLength(2));
      await expect(f.tts.synthesize(request("crash-worker", "crash"))).rejects.toThrow("exited");
      await finishRemovals();
      const plays = () => send.mock.calls.map(([event]) => event).filter(event => event.type === "play-audio");
      for (const audio of ready) await expect(access(audio.path)).resolves.toBeUndefined();
      router.receive({ type: "audio-finished", id: plays()[0].audioId, phase: "end" });
      expect(plays()).toHaveLength(2);
      await expect(access(plays()[1].path)).resolves.toBeUndefined();
      await vi.waitFor(async () => { await expect(access(ready[0]!.path)).rejects.toThrow(); });
      router.receive({ type: "audio-finished", id: plays()[1].audioId, phase: "end" });
      await vi.waitFor(async () => { await expect(access(ready[1]!.path)).rejects.toThrow(); });
    } finally { router.dispose(); }
    await vi.waitFor(async () => { await expect(access(dirname(ready[0]!.path))).rejects.toThrow(); });
  });
  it("preserves caller-owned custom audio directories on disposal", async () => {
    const f = await fixture(), audio = await f.tts.synthesize(request("one"));
    await expect(f.tts.synthesize(request("crash-worker", "crash"))).rejects.toThrow("exited");
    await finishRemovals();
    f.tts.dispose();
    await expect(access(audio.path)).resolves.toBeUndefined();
  });
  it("keeps exactly one exit cleanup across failed runs and unregisters it on disposal", async () => {
    const baseline = process.listenerCount("exit");
    const f = await fixture({ defaultAudio: true });
    await f.tts.synthesize(request("one"));
    for (const id of ["first", "second"]) {
      await expect(f.tts.synthesize(request(id, "crash"))).rejects.toThrow("exited");
      expect(process.listenerCount("exit")).toBe(baseline + 1);
      await f.tts.synthesize(request(id + "-restart"));
      expect(process.listenerCount("exit")).toBe(baseline + 1);
    }
    f.tts.dispose();
    expect(process.listenerCount("exit")).toBe(baseline);
  });
  it("cleans retained audio synchronously on process exit", async () => {
    const baseline = new Set(process.listeners("exit")), f = await fixture({ defaultAudio: true });
    const first = await f.tts.synthesize(request("one"));
    await expect(f.tts.synthesize(request("crash-worker", "crash"))).rejects.toThrow("exited");
    const second = await f.tts.synthesize(request("two"));
    const cleanup = process.listeners("exit").find(listener => !baseline.has(listener));
    expect(cleanup).toBeDefined();
    cleanup!.call(process, 0);
    await expect(access(first.path)).rejects.toThrow();
    await expect(access(second.path)).rejects.toThrow();
    await expect(f.tts.synthesize(request("three"))).rejects.toThrow("closed");
  });
  it("discards late validation from a failed run without deleting the restarted run's audio", async () => {
    const f = await fixture({ defaultAudio: true });
    const validation = Promise.withResolvers<string>(), release = Promise.withResolvers<void>();
    const actualStat = vi.mocked(stat).getMockImplementation()!;
    vi.mocked(stat).mockImplementationOnce(async path => {
      const result = await actualStat(path);
      validation.resolve(String(path)); await release.promise;
      return result;
    });
    const pending = f.tts.synthesize(request("reused")).catch(error => error as Error);
    const oldPath = await validation.promise;
    try {
      await expect(f.tts.synthesize(request("crash-worker", "crash"))).rejects.toThrow("exited");
      const current = await f.tts.synthesize(request("reused"));
      release.resolve();
      expect(await pending).toMatchObject({ message: "Local speech worker exited" });
      await vi.waitFor(async () => { await expect(access(oldPath)).rejects.toThrow(); });
      await expect(access(current.path)).resolves.toBeUndefined();
    } finally { release.resolve(); }
  });
  it("loads lazily, reuses one process, and decodes UTF-8 split across stdout chunks", async () => {
    const f = await fixture(); await expect(access(f.launches)).rejects.toThrow();
    const first = await f.tts.synthesize(request("one"));
    const second = await f.tts.synthesize(request("two"));
    expect(first).toMatchObject({ duration: 0.01, sampleRate: 24000 });
    expect(second.path).toContain("голос-two.wav");
    expect((await readFile(f.launches, "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it.each(["escape", "symlink"])("rejects a %s path outside the audio directory", async mode => {
    const f = await fixture();
    await expect(f.tts.synthesize(request("one", mode))).rejects.toThrow("invalid audio file");
    await expect(access(f.outside)).resolves.toBeUndefined();
  });
  it("bounds stdout frames and restarts cleanly after a failed worker", async () => {
    const f = await fixture();
    await expect(f.tts.synthesize(request("one", "large"))).rejects.toThrow("frame limit");
    await expect(f.tts.synthesize(request("two"))).resolves.toMatchObject({ sampleRate: 24000 });
    expect((await readFile(f.launches, "utf8")).trim().split("\n")).toHaveLength(2);
  });
  it.each(["invalid", "error", "crash"])("reports %s failures without exposing worker output or speech text", async mode => {
    const f = await fixture();
    const error = await f.tts.synthesize(request("one", mode)).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("SECRET");
    expect(f.logs.join("\n")).not.toContain("SECRET");
  });
  it("rejects a missing interpreter without leaving startup pending", async () => {
    const tts = new LocalTts({ python: "/definitely-missing-codexbridge-python" }); instances.push(tts);
    await expect(tts.synthesize(request("one"))).rejects.toThrow("could not start");
  });
  it("bounds startup and generation time", async () => {
    const cold = await fixture({ startupHang: true, startupTimeoutMs: 100 });
    await expect(cold.tts.synthesize(request("one"))).rejects.toThrow("startup timed out");
    const warm = await fixture({ requestTimeoutMs: 100 });
    await expect(warm.tts.synthesize(request("one", "hang"))).rejects.toThrow("generation timed out");
    await expect(warm.tts.synthesize(request("two"))).resolves.toMatchObject({ sampleRate: 24000 });
  });
  it("rejects pending work and future requests on disposal", async () => {
    const f = await fixture(); await f.tts.synthesize(request("warmup"));
    const pending = f.tts.synthesize(request("one", "hang"));
    await new Promise(resolve => setImmediate(resolve));
    f.tts.dispose();
    await expect(pending).rejects.toThrow("closed");
    await expect(f.tts.synthesize(request("two"))).rejects.toThrow("closed");
    expect(f.logs).toEqual([]);
  });
});
