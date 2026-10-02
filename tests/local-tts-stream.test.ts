import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalTts } from "../packages/companions/src/local-tts.js";
import type { LocalSpeechChunk } from "../packages/companions/src/speech-stream.js";

vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, stat: vi.fn(fs.stat) };
});
const directories: string[] = [], instances: LocalTts[] = [];
const source = fileURLToPath(new URL("../packages/companions/tts/", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixtures/tts-stream-worker.py", import.meta.url));
const request = (id: string, voice = "normal", text = "Проверяю длинную публичную реплику без смены голоса. ".repeat(3)) => ({ id, text, voice });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(requestTimeoutMs = 2000) {
  const directory = await mkdtemp(join(tmpdir(), "codexbridge-stream-")); directories.push(directory);
  const worker = join(directory, "worker.py"), log = join(directory, "worker.log"), audioDirectory = join(directory, "audio");
  await writeFile(worker, (await readFile(fixturePath, "utf8")).replace("TTS_SOURCE", JSON.stringify(source)).replace("FIXTURE_LOG", JSON.stringify(log)));
  const tts = new LocalTts({ python: "python3", worker, audioDirectory, requestTimeoutMs }); instances.push(tts);
  return { tts, audioDirectory, log };
}

afterEach(async () => {
  instances.splice(0).forEach(instance => instance.dispose());
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  vi.mocked(stat).mockClear();
});

describe("incremental local speech", () => {
  it("delivers ordered PCM before completion, including a short tail with no final library flag", async () => {
    const f = await fixture(), events: string[] = [], chunks: LocalSpeechChunk[] = [];
    await f.tts.stream(request("one"), { start: () => events.push("start"), chunk: audio => { events.push("chunk"); chunks.push(audio); } });
    events.push("end");
    expect(events).toEqual(["start", "chunk", "chunk", "chunk", "end"]);
    expect(chunks.map(({ index, duration }) => [index, duration])).toEqual([[0, 2], [1, 2], [2, 0.32]]);
    for (const chunk of chunks) { await expect(access(chunk.path)).resolves.toBeUndefined(); f.tts.consumed("one", chunk.index); }
    expect(await readFile(f.log, "utf8")).toContain("closed:normal\nreset:normal");
  });

  it("accepts decoder-edge samples inside the advance reservation without altering PCM", async () => {
    const f = await fixture(), chunks: LocalSpeechChunk[] = [];
    await f.tts.stream(request("edge", "edge"), { chunk: audio => chunks.push(audio) });
    expect(chunks.map(audio => audio.duration)).toEqual([2.04, 0.32]);
  });

  it("keeps global credits across completed requests and responds to cancellation while blocked", async () => {
    const f = await fixture(100), first: LocalSpeechChunk[] = [], next: LocalSpeechChunk[] = [];
    await f.tts.stream(request("first"), { chunk: audio => first.push(audio) });
    const abort = new AbortController();
    const current = f.tts.stream(request("second", "flow"), { chunk: audio => next.push(audio) }, abort.signal).catch(error => error as Error);
    await vi.waitFor(() => expect(next).toHaveLength(3));
    await delay(250); // More than the request watchdog, while credit wait is intentional.
    expect(next).toHaveLength(3);
    expect(first.concat(next).reduce((sum, audio) => sum + audio.duration, 0)).toBeLessThanOrEqual(12);
    abort.abort();
    expect(await current).toMatchObject({ message: "Local speech generation cancelled" });
    for (const chunk of first) f.tts.consumed("first", chunk.index);
    for (const chunk of next) f.tts.consumed("second", chunk.index);
    await expect(f.tts.stream(request("third"), { chunk: audio => f.tts.consumed("third", audio.index) })).resolves.toBeUndefined();
    expect((await readFile(f.log, "utf8")).match(/^launch$/gm)).toHaveLength(1);
    expect(await readFile(f.log, "utf8")).toContain("closed:flow\nreset:flow");
  });

  it("never releases backpressure twice for a duplicate consume confirmation", async () => {
    const f = await fixture(100), chunks: LocalSpeechChunk[] = [];
    const completion = f.tts.stream(request("flow", "flow"), { chunk: audio => chunks.push(audio) });
    await vi.waitFor(() => expect(chunks).toHaveLength(5));
    f.tts.consumed("flow", 0); f.tts.consumed("flow", 0);
    await vi.waitFor(() => expect(chunks).toHaveLength(6));
    await delay(200);
    expect(chunks).toHaveLength(6);
    for (const audio of chunks) f.tts.consumed("flow", audio.index);
    await completion;
    expect(chunks).toHaveLength(8);
  });

  it("serializes asynchronous WAV validation before delivering chunks or stream-end", async () => {
    const f = await fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), indices: number[] = [];
    const implementation = vi.mocked(stat).getMockImplementation()!;
    vi.mocked(stat).mockImplementationOnce(async path => { const result = await implementation(path); entered.resolve(); await gate.promise; return result; });
    let ended = false;
    const result = f.tts.stream(request("ordered"), { chunk: audio => indices.push(audio.index) }).then(() => { ended = true; });
    try {
      await entered.promise; await delay(60);
      expect(indices).toEqual([]); expect(ended).toBe(false);
      gate.resolve(); await result;
      expect(indices).toEqual([0, 1, 2]); expect(ended).toBe(true);
    } finally { gate.resolve(); }
  });

  it("aborts promptly during generation, discards late output, and reuses the only worker", async () => {
    const f = await fixture(), chunks: LocalSpeechChunk[] = [], abort = new AbortController();
    const result = f.tts.stream(request("cancelled", "cancel"), { chunk: audio => chunks.push(audio) }, abort.signal).catch(error => error as Error);
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    abort.abort(); expect(await result).toMatchObject({ message: "Local speech generation cancelled" });
    for (const chunk of chunks) f.tts.consumed("cancelled", chunk.index);
    await f.tts.stream(request("next"), { chunk: audio => f.tts.consumed("next", audio.index) });
    expect(chunks).toHaveLength(1);
    expect((await readFile(f.log, "utf8")).match(/^launch$/gm)).toHaveLength(1);
    expect(await readFile(f.log, "utf8")).toContain("closed:cancel\nreset:cancel");
  });

  it("removes output arriving after completed-stream retirement without deleting issued WAVs", async () => {
    const f = await fixture(), chunks: LocalSpeechChunk[] = [];
    await f.tts.stream(request("retired", "late"), { chunk: audio => chunks.push(audio) });
    await delay(150);
    expect(chunks).toHaveLength(3);
    await expect(access(join(f.audioDirectory, "speech-late.wav"))).rejects.toThrow();
    for (const audio of chunks) await expect(access(audio.path)).resolves.toBeUndefined();
    await f.tts.stream(request("next"), { chunk: audio => f.tts.consumed("next", audio.index) });
  });

  it.each(["reorder", "duplicate", "bad-pcm", "bad-duration", "overflow"])("rejects %s output without exposing invalid audio to playback", async voice => {
    const f = await fixture(), chunks: LocalSpeechChunk[] = [];
    await expect(f.tts.stream(request(voice, voice), { chunk: audio => chunks.push(audio) })).rejects.toThrow(/invalid|budget/);
    expect(chunks.reduce((sum, audio) => sum + audio.duration, 0)).toBeLessThanOrEqual(12);
    if (["reorder", "bad-pcm", "bad-duration"].includes(voice)) expect(chunks).toHaveLength(0);
  });

  it("enforces cumulative speech limits even when every individual PCM portion is valid", async () => {
    const f = await fixture(), chunks: LocalSpeechChunk[] = [];
    await expect(f.tts.stream(request("budget", "budget", "Коротко."), { chunk: audio => { chunks.push(audio); f.tts.consumed("budget", audio.index); } })).rejects.toThrow("generation failed");
    expect(chunks.reduce((sum, audio) => sum + audio.duration, 0)).toBeLessThanOrEqual(15);
    expect(await readFile(f.log, "utf8")).toContain("closed:budget\nreset:budget");
  });

  it("preserves already-issued PCM across worker death and resets for a new generation", async () => {
    const f = await fixture(), chunks: LocalSpeechChunk[] = [];
    await expect(f.tts.stream(request("crash", "crash"), { chunk: audio => chunks.push(audio) })).rejects.toThrow("exited");
    expect(chunks).toHaveLength(1);
    for (const audio of chunks) { await expect(access(audio.path)).resolves.toBeUndefined(); f.tts.consumed("crash", audio.index); }
    await expect(f.tts.stream(request("after-crash"), { chunk: audio => f.tts.consumed("after-crash", audio.index) })).resolves.toBeUndefined();
    expect((await readFile(f.log, "utf8")).match(/^launch$/gm)).toHaveLength(2);
  });

  it("cleans queued validation after cancellation without accepting later chunks", async () => {
    const f = await fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const implementation = vi.mocked(stat).getMockImplementation()!;
    vi.mocked(stat).mockImplementationOnce(async path => { const result = await implementation(path); entered.resolve(); await gate.promise; return result; });
    const abort = new AbortController(), chunks: LocalSpeechChunk[] = [];
    const result = f.tts.stream(request("validation"), { chunk: audio => chunks.push(audio) }, abort.signal).catch(error => error as Error);
    try {
      await entered.promise; abort.abort(); gate.resolve();
      expect(await result).toMatchObject({ message: "Local speech generation cancelled" });
      await vi.waitFor(async () => expect(await readdir(f.audioDirectory)).toEqual([]));
      expect(chunks).toEqual([]);
    } finally { gate.resolve(); }
  });
});
