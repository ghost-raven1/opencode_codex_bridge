import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const home = vi.hoisted(() => ({ directory: "" }));
vi.mock("node:os", async original => ({ ...await original<object>(), homedir: () => home.directory }));
import { LocalTts } from "../packages/companions/src/local-tts.js";

const instances: LocalTts[] = [];
const directories: string[] = [];
beforeEach(async () => {
  home.directory = await mkdtemp(join(tmpdir(), "codexbridge-tts-home-")); directories.push(home.directory);
});
afterEach(async () => {
  instances.splice(0).forEach(instance => instance.dispose());
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(options: { startupHang?: boolean; requestTimeoutMs?: number; startupTimeoutMs?: number; defaultAudio?: boolean } = {}) {
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
 path=directory / ("голос-" + request["id"] + ".wav")
 with wave.open(str(path), "wb") as file:
  file.setnchannels(1); file.setsampwidth(2); file.setframerate(24000); file.writeframes(bytes(480))
 if mode == "escape": path=outside
 if mode == "symlink":
  path.unlink(); path.symlink_to(outside)
 result=json.dumps({"type":"audio", "id":request["id"], "path":str(path), "duration":0.01, "sampleRate":24000}, ensure_ascii=False).encode("utf8")
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
describe("local speech worker channel", () => {
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
  it("does not let cleanup of a failed worker delete audio produced after its restart", async () => {
    const f = await fixture({ defaultAudio: true }), previous = await f.tts.synthesize(request("one"));
    await expect(f.tts.synthesize(request("bad", "large"))).rejects.toThrow("frame limit");
    const next = await f.tts.synthesize(request("two"));
    expect(dirname(next.path)).not.toBe(dirname(previous.path));
    await vi.waitFor(async () => { await expect(access(dirname(previous.path))).rejects.toThrow(); });
    await expect(access(next.path)).resolves.toBeUndefined();
  });
  it("preserves caller-owned custom audio directories on disposal", async () => {
    const f = await fixture(), audio = await f.tts.synthesize(request("one"));
    f.tts.dispose();
    await expect(access(audio.path)).resolves.toBeUndefined();
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
