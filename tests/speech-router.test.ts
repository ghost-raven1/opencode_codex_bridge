import { describe, expect, it, vi } from "vitest";
import { configSchema, voiceDefaults } from "../packages/companions/src/config.js";
import { SpeechRouter, speechChunks } from "../packages/companions/src/speech-router.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup() {
  const pending: { resolve: (audio: { path: string; duration: number; sampleRate: number }) => void; reject: () => void }[] = [];
  const synthesize = vi.fn(() => new Promise<{ path: string; duration: number; sampleRate: number }>((resolve, reject) => pending.push({ resolve, reject })));
  const send = vi.fn(), log = vi.fn(), remove = vi.fn(async (_path: string) => {}), dispose = vi.fn();
  const router = new SpeechRouter(configSchema.parse({ tts: { engine: "local" } }), { synthesize, dispose }, send, log, remove);
  return { router, synthesize, send, log, remove, dispose, pending,
    finish: async (index = 0) => { pending[index]!.resolve({ path: `/audio/${index}.wav`, duration: 2, sampleRate: 24000 }); await tick(); } };
}

describe("local role voices", () => {
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
  it("waits for actual playback completion before generating the next role", async () => {
    const t = setup();
    t.router.event({ type: "speak", characterId: "a", role: "developer", text: "Проверю код." });
    t.router.event({ type: "speak", characterId: "b", role: "reviewer", text: "Проверю изменения." });
    expect(t.synthesize).toHaveBeenCalledTimes(1);
    expect(t.synthesize.mock.calls[0]?.[0]).toMatchObject({ voice: "Vivian" });
    await t.finish();
    const playback = t.send.mock.calls[0]![0];
    expect(playback).toMatchObject({ type: "play-audio", characterId: "a" });
    expect(t.synthesize).toHaveBeenCalledTimes(1);
    t.router.receive({ type: "audio-finished", id: "unrelated", phase: "end" });
    expect(t.synthesize).toHaveBeenCalledTimes(1);
    t.router.receive({ type: "audio-finished", id: playback.audioId, phase: "end" });
    expect(t.remove).toHaveBeenCalledWith("/audio/0.wav");
    expect(t.synthesize).toHaveBeenCalledTimes(2);
    expect(t.synthesize.mock.calls[1]?.[0]).toMatchObject({ voice: "Ono_Anna" });
    t.router.dispose(); await t.finish(1);
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
