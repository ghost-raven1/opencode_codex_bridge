import { describe, expect, it, vi } from "vitest";
import { configSchema, voiceDefaults } from "../packages/companions/src/config.js";
import { SpeechRouter, speechChunks } from "../packages/companions/src/speech-router.js";
import { CompanionLifecycle } from "../packages/companions/src/lifecycle.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup() {
  const pending: { resolve: (audio: { path: string; duration: number; sampleRate: number }) => void; reject: () => void }[] = [];
  const synthesize = vi.fn(() => new Promise<{ path: string; duration: number; sampleRate: number }>((resolve, reject) => pending.push({ resolve, reject })));
  const send = vi.fn(), captions = vi.fn(), log = vi.fn(), remove = vi.fn(async (_path: string) => {}), dispose = vi.fn();
  const router = new SpeechRouter(configSchema.parse({ tts: { engine: "local" } }), { synthesize, dispose },
    event => (event as { type: string }).type === "caption" ? captions(event) : send(event), log, remove);
  return { router, synthesize, send, captions, log, remove, dispose, pending,
    finish: async (index = 0) => { pending[index]!.resolve({ path: `/audio/${index}.wav`, duration: 2, sampleRate: 24000 }); await tick(); } };
}

describe("local role voices", () => {
  it("retries a failed local playback once through macOS and ignores callbacks from the failed attempt", async () => {
    const t = setup();
    t.router.event({ type: "speak", characterId: "a", role: "researcher", text: "Проверяю источники." });
    t.router.event({ type: "speak", characterId: "b", text: "Следующая реплика." });
    await t.finish(); await t.finish(1);
    const failed = t.send.mock.calls[0]![0];
    t.router.receive({ type: "audio-finished", id: failed.audioId, phase: "error" });
    const fallback = t.send.mock.calls[1]![0];
    expect(fallback).toMatchObject({ type: "speak", characterId: "a", role: "researcher", text: "Проверяю источники." });
    expect(fallback.audioId).not.toBe(failed.audioId);
    expect(t.remove).toHaveBeenCalledWith("/audio/0.wav");
    for (const phase of ["end", "error"]) t.router.receive({ type: "audio-finished", id: failed.audioId, phase });
    expect(t.send).toHaveBeenCalledTimes(2);
    // Even a failed system voice advances the queue instead of starting an infinite retry.
    t.router.receive({ type: "audio-finished", id: fallback.audioId, phase: "error" });
    expect(t.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "play-audio", characterId: "b" }));
    t.router.dispose();
  });
  it("keeps the fallback and prefetched next phrase pending past the failed audio watchdog", async () => {
    vi.useFakeTimers();
    const send = vi.fn(), changed = vi.fn(), remove = vi.fn(async () => {});
    const config = configSchema.parse({ tts: { engine: "local" } });
    const router = new SpeechRouter(config, {
      synthesize: async ({ id }) => ({ path: `/audio/${id}.wav`, duration: 2, sampleRate: 24000 }), dispose() {},
    }, send, () => {}, remove, { changed, voiceFor: (_, role) => config.tts.voices[role] });
    try {
      for (const characterId of ["a", "b"]) router.event({ type: "speak", characterId, text: "Проверка." });
      await vi.advanceTimersByTimeAsync(0);
      const failed = send.mock.calls.find(([event]) => event.type === "play-audio")![0];
      router.receive({ type: "audio-finished", id: failed.audioId, phase: "error" });
      const retry = send.mock.calls.at(-1)![0];
      await vi.advanceTimersByTimeAsync(13_000);
      expect(send.mock.calls.filter(([event]) => ["play-audio", "speak", "stop"].includes(event.type)))
        .toHaveLength(2);
      expect(changed).toHaveBeenLastCalledWith(new Set(["a", "b"]), "a");
      router.receive({ type: "audio-finished", id: retry.audioId, phase: "end" });
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "play-audio", characterId: "b" }));
      expect(changed).toHaveBeenLastCalledWith(new Set(["b"]), "b");
      expect(remove).toHaveBeenCalledOnce();
    } finally { router.dispose(); vi.useRealTimers(); }
  });
  it.each(["mute", "suspend", "stop"])("cancels the playback retry on %s without replaying queued audio", async action => {
    const t = setup();
    for (const characterId of ["a", "b"]) t.router.event({ type: "speak", characterId, text: "Проверка." });
    await t.finish(); await t.finish(1);
    const failed = t.send.mock.calls[0]![0];
    t.router.receive({ type: "audio-finished", id: failed.audioId, phase: "error" });
    const retry = t.send.mock.calls[1]![0];
    t.router.receive({ type: "speech-control", action, muted: true, suspended: true });
    const sent = t.send.mock.calls.length;
    for (const id of [failed.audioId, retry.audioId]) {
      t.router.receive({ type: "audio-finished", id, phase: "error" });
      t.router.receive({ type: "audio-finished", id, phase: "end" });
    }
    expect(t.send).toHaveBeenCalledTimes(sent);
    expect(t.remove.mock.calls.map(([path]) => path).sort()).toEqual(["/audio/0.wav", "/audio/1.wav"]);
    t.router.dispose();
  });
  it("publishes the full public caption before synthesis and keeps it after speech ends", async () => {
    const t = setup(), text = "Проверяю публичный ответ до готовности синтезатора. ".repeat(12).trim();
    t.router.event({ type: "speak", characterId: "a", text });
    expect(t.captions).toHaveBeenCalledWith({ type: "caption", characterId: "a", text });
    expect(t.captions.mock.invocationCallOrder[0]).toBeLessThan(t.synthesize.mock.invocationCallOrder[0]!);
    expect(t.send).not.toHaveBeenCalled();
    await t.finish();
    t.router.receive({ type: "audio-finished", id: t.send.mock.calls[0]![0].audioId, phase: "end" });
    expect(t.captions).toHaveBeenCalledTimes(1);
    t.router.dispose();
  });
  it.each(["mute", "suspend"])("publishes captions while native %s disables audio", action => {
    const t = setup();
    t.router.receive({ type: "speech-control", action, muted: true, suspended: true });
    t.router.event({ type: "speak", characterId: "a", text: "Ответ остаётся доступным для чтения." });
    expect(t.captions).toHaveBeenCalledOnce(); expect(t.synthesize).not.toHaveBeenCalled();
    t.router.receive({ type: "speech-control", action: "stop" });
    expect(t.captions).toHaveBeenLastCalledWith({ type: "caption", characterId: "a", text: "" });
    t.router.dispose();
  });
  it("clears only the cancelled task caption, preserves visual eviction, and sends nothing on disposal", () => {
    const t = setup();
    t.router.receive({ type: "speech-control", action: "mute", muted: true });
    for (const characterId of ["a", "b"]) t.router.event({ type: "speak", characterId, text: "Публичная реплика." });
    const eviction = { type: "remove" as const, characterId: "b", visualOnly: true };
    t.router.event(eviction);
    expect(t.captions).toHaveBeenCalledTimes(2);
    t.router.event({ type: "stop", characterId: "a" });
    expect(t.captions).toHaveBeenLastCalledWith({ type: "caption", characterId: "a", text: "" });
    t.router.event({ type: "remove", characterId: "b" });
    expect(t.captions).toHaveBeenLastCalledWith({ type: "caption", characterId: "b", text: "" });
    const count = t.captions.mock.calls.length; t.router.dispose(); expect(t.captions).toHaveBeenCalledTimes(count);
  });
  it("changes role during playback without stopping speech; the next utterance uses the free preferred voice", async () => {
    const config = configSchema.parse({ tts: { engine: "local" } }), send = vi.fn();
    const synthesize = vi.fn(async () => ({ path: "/audio/test.wav", duration: 2, sampleRate: 24000 }));
    let life: CompanionLifecycle;
    const router = new SpeechRouter(config, { synthesize, dispose() {} }, send, () => {}, async () => {}, {
      changed: (pending, speaker) => life.speechActivity(pending, speaker),
      voiceFor: (id, role) => life.voiceFor(id, role),
    });
    life = new CompanionLifecycle(config, event => router.event(event));
    life.event({ type: "state", characterId: "a", taskId: "task", role: "developer", state: "working" });
    life.event({ type: "speak", characterId: "a", taskId: "task", role: "developer", text: "Первая реплика." });
    await tick();
    const first = send.mock.calls.find(([event]) => event.type === "play-audio")![0];
    life.event({ type: "state", characterId: "a", taskId: "task", role: "researcher", state: "working" });
    life.event({ type: "speak", characterId: "a", taskId: "task", role: "researcher", text: "Новая роль." });
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.some(([event]) => event.type === "stop")).toBe(false);
    router.receive({ type: "audio-finished", id: first.audioId, phase: "end" });
    await tick();
    expect(synthesize.mock.calls[0]?.[0]).toMatchObject({ voice: "Vivian" });
    expect(synthesize.mock.calls[1]?.[0]).toMatchObject({ voice: "Sohee" });
    life.dispose(); router.dispose();
  });
  it("gives every role a separate voice and includes child sessions by default", () => {
    expect(new Set(Object.values(voiceDefaults)).size).toBe(4);
    expect(configSchema.parse({}).speech).toBe("all");
  });
  it("preserves text while splitting long speech into bounded chunks", () => {
    const text = ("Проверю последний коммит с авторизацией и связанный код моста. ").repeat(20).trim();
    const chunks = speechChunks(text);
    expect(chunks.every(chunk => chunk.length <= 320)).toBe(true);
    expect(chunks.join(" ")).toBe(text);
  });
  it("prepares the next role during playback and starts its ready audio immediately on completion", async () => {
    const t = setup();
    t.router.event({ type: "speak", characterId: "a", role: "developer", text: "Проверю код." });
    t.router.event({ type: "speak", characterId: "b", role: "reviewer", text: "Проверю изменения." });
    expect(t.synthesize).toHaveBeenCalledTimes(1);
    expect(t.synthesize.mock.calls[0]?.[0]).toMatchObject({ voice: "Vivian" });
    await t.finish();
    const playback = t.send.mock.calls[0]![0];
    expect(playback).toMatchObject({ type: "play-audio", characterId: "a" });
    expect(t.synthesize).toHaveBeenCalledTimes(2);
    expect(t.synthesize.mock.calls[1]?.[0]).toMatchObject({ voice: "Ono_Anna" });
    await t.finish(1);
    expect(t.send.mock.calls.filter(([event]) => event.type === "play-audio")).toHaveLength(1);
    t.router.receive({ type: "audio-finished", id: "unrelated", phase: "end" });
    expect(t.send.mock.calls.filter(([event]) => event.type === "play-audio")).toHaveLength(1);
    t.router.receive({ type: "audio-finished", id: playback.audioId, phase: "end" });
    expect(t.remove).toHaveBeenCalledWith("/audio/0.wav");
    expect(t.synthesize).toHaveBeenCalledTimes(2);
    expect(t.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "play-audio", characterId: "b", path: "/audio/1.wav" }));
    t.router.dispose();
  });
  it("bounds prefetch to one ready utterance and keeps a single model request in flight", async () => {
    const t = setup();
    for (const characterId of ["a", "b", "c", "d"]) t.router.event({ type: "speak", characterId, text: "Проверка очереди." });
    expect(t.synthesize).toHaveBeenCalledTimes(1);
    await t.finish();
    expect(t.synthesize).toHaveBeenCalledTimes(2);
    await t.finish(1);
    expect(t.synthesize).toHaveBeenCalledTimes(2);
    t.router.receive({ type: "audio-finished", id: t.send.mock.calls[0]![0].audioId, phase: "end" });
    expect(t.synthesize).toHaveBeenCalledTimes(3);
    expect(t.send.mock.calls.filter(([event]) => event.type === "play-audio")).toHaveLength(2);
    t.router.dispose(); await t.finish(2);
    expect(t.remove.mock.calls.map(([path]) => path).sort()).toEqual(["/audio/0.wav", "/audio/1.wav", "/audio/2.wav"]);
  });
  it.each(["mute", "suspend", "stop"])("deletes a ready prefetch and never replays it after native %s", async action => {
    const t = setup();
    t.router.event({ type: "speak", characterId: "a", text: "Первая реплика." });
    t.router.event({ type: "speak", characterId: "b", text: "Вторая реплика." });
    await t.finish(); await t.finish(1);
    const first = t.send.mock.calls[0]![0];
    t.router.receive({ type: "speech-control", action, muted: true, suspended: true });
    t.router.receive({ type: "audio-finished", id: first.audioId, phase: "end" });
    expect(t.remove.mock.calls.map(([path]) => path).sort()).toEqual(["/audio/0.wav", "/audio/1.wav"]);
    expect(t.send.mock.calls.filter(([event]) => event.type === "play-audio")).toHaveLength(1);
    t.router.dispose();
  });
  it("discards a cancelled prefetch but allows other characters to prepare", async () => {
    const t = setup();
    for (const characterId of ["a", "b", "c"]) t.router.event({ type: "speak", characterId, text: "Проверка." });
    await t.finish();
    t.router.event({ type: "stop", characterId: "b" });
    await t.finish(1);
    expect(t.remove).toHaveBeenCalledWith("/audio/1.wav");
    expect(t.synthesize).toHaveBeenCalledTimes(3);
    expect(t.send.mock.calls.filter(([event]) => event.type === "play-audio")).toHaveLength(1);
    await t.finish(2);
    t.router.receive({ type: "audio-finished", id: t.send.mock.calls[0]![0].audioId, phase: "end" });
    expect(t.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "play-audio", characterId: "c" }));
    t.router.dispose();
  });
  it("drops cancelled in-flight audio and keeps other agents queued without overlapping synthesis", async () => {
    const t = setup();
    t.router.event({ type: "speak", characterId: "a", text: "Старый ответ." });
    t.router.event({ type: "speak", characterId: "b", text: "Другой агент." });
    t.router.event({ type: "stop", characterId: "a" });
    expect(t.synthesize).toHaveBeenCalledTimes(1);
    await t.finish();
    expect(t.remove).toHaveBeenCalledWith("/audio/0.wav");
    expect(t.send.mock.calls.some(([event]) => event.type === "play-audio")).toBe(false);
    expect(t.synthesize).toHaveBeenCalledTimes(2);
    t.router.dispose(); await t.finish(1);
  });
  it.each(["mute", "suspend", "stop"])("cancels pending speech when native %s is requested", async action => {
    const t = setup();
    t.router.event({ type: "speak", characterId: "a", text: "Первая реплика." });
    t.router.event({ type: "speak", characterId: "b", text: "Вторая реплика." });
    t.router.receive({ type: "speech-control", action, muted: true, suspended: true });
    await t.finish();
    expect(t.synthesize).toHaveBeenCalledTimes(1);
    expect(t.send.mock.calls.some(([event]) => event.type === "play-audio")).toBe(false);
    t.router.dispose();
  });
  it("falls back once to macOS and still waits for its speech callbacks", async () => {
    const t = setup();
    t.router.event({ type: "speak", characterId: "a", role: "researcher", text: "Проверяю источники." });
    t.router.event({ type: "speak", characterId: "b", text: "Готово." });
    t.pending[0]!.reject(); await tick();
    expect(t.send).toHaveBeenCalledWith(expect.objectContaining({ type: "speak", role: "researcher" }));
    expect(t.log).toHaveBeenCalledTimes(1);
    t.router.receive({ type: "speech", characterId: "a", phase: "word" });
    expect(t.send).toHaveBeenCalledTimes(1);
    t.router.receive({ type: "audio-finished", id: t.send.mock.calls[0]![0].audioId, phase: "end" });
    expect(t.send).toHaveBeenCalledTimes(2);
    expect(t.synthesize).toHaveBeenCalledTimes(1);
    t.router.dispose();
  });
  it("keeps current audio playing when prefetched synthesis fails, then falls back in order", async () => {
    const t = setup();
    t.router.event({ type: "speak", characterId: "a", text: "Текущая реплика." });
    t.router.event({ type: "speak", characterId: "b", text: "Следующая реплика." });
    await t.finish();
    const first = t.send.mock.calls[0]![0];
    t.pending[1]!.reject(); await tick();
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.log).toHaveBeenCalledOnce();
    t.router.receive({ type: "audio-finished", id: first.audioId, phase: "end" });
    expect(t.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "speak", characterId: "b" }));
    t.router.dispose();
  });
  it("reports queued and prepared characters as pending while only the player is the speaker", async () => {
    const changed = vi.fn(), config = configSchema.parse({ tts: { engine: "local" } });
    const resolve: ((audio: { path: string; duration: number; sampleRate: number }) => void)[] = [];
    const router = new SpeechRouter(config, {
      synthesize: () => new Promise(done => resolve.push(done)), dispose() {},
    }, () => {}, () => {}, async () => {}, {
      changed, voiceFor: (_, role) => config.tts.voices[role],
    });
    for (const characterId of ["a", "b", "c"]) router.event({ type: "speak", characterId, text: "Проверка." });
    expect(changed).toHaveBeenLastCalledWith(new Set(["a", "b", "c"]), undefined);
    resolve[0]!({ path: "/audio/a.wav", duration: 2, sampleRate: 24000 }); await tick();
    resolve[1]!({ path: "/audio/b.wav", duration: 2, sampleRate: 24000 }); await tick();
    expect(changed).toHaveBeenLastCalledWith(new Set(["a", "b", "c"]), "a");
    router.event({ type: "stop", characterId: "b" });
    expect(changed).toHaveBeenLastCalledWith(new Set(["a", "c"]), "a");
    router.dispose(); resolve[2]!({ path: "/audio/c.wav", duration: 2, sampleRate: 24000 }); await tick();
  });
  it("stops a playback command that crossed the native Stop event", async () => {
    const t = setup();
    t.router.event({ type: "speak", characterId: "a", text: "Проверка." });
    await t.finish();
    t.router.receive({ type: "speech-control", action: "stop" });
    expect(t.send.mock.calls.map(([event]) => event.type)).toEqual(["play-audio", "stop"]);
    expect(t.remove).toHaveBeenCalledWith("/audio/0.wav");
    t.router.dispose();
  });
  it("ignores a delayed fallback completion from an older utterance of the same agent", async () => {
    const t = setup();
    t.router.event({ type: "speak", characterId: "a", text: "Старый ответ." });
    t.pending[0]!.reject(); await tick();
    const oldId = t.send.mock.calls[0]![0].audioId;
    t.router.event({ type: "stop", characterId: "a" });
    t.router.event({ type: "speak", characterId: "a", text: "Новый ответ." });
    t.router.event({ type: "speak", characterId: "b", text: "Другой агент." });
    const before = t.send.mock.calls.length;
    t.router.receive({ type: "audio-finished", id: oldId, phase: "cancel" });
    expect(t.send).toHaveBeenCalledTimes(before);
    t.router.receive({ type: "audio-finished", id: t.send.mock.calls.at(-1)![0].audioId, phase: "end" });
    expect(t.send).toHaveBeenLastCalledWith(expect.objectContaining({ characterId: "b", type: "speak" }));
    t.router.dispose();
  });
  it("cleans up completed synthesis after disposal without playing it", async () => {
    const t = setup();
    t.router.event({ type: "speak", characterId: "a", text: "Проверка." });
    t.router.dispose(); await t.finish();
    expect(t.remove).toHaveBeenCalledWith("/audio/0.wav");
    expect(t.send).not.toHaveBeenCalled(); expect(t.dispose).toHaveBeenCalledOnce();
  });
});
