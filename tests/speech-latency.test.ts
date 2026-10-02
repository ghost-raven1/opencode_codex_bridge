import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { SpeechRouter } from "../packages/companions/src/speech-router.js";

type Audio = { path: string; duration: number; sampleRate: number };
const routers: SpeechRouter[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { routers.splice(0).forEach(router => router.dispose()); vi.useRealTimers(); });
function setup() {
  const pending: { resolve: (audio: Audio) => void; reject: (error: Error) => void }[] = [];
  const synthesize = vi.fn(() => new Promise<Audio>((resolve, reject) => pending.push({ resolve, reject })));
  const send = vi.fn(), remove = vi.fn(async () => {}), changed = vi.fn(), log = vi.fn();
  const config = configSchema.parse({ tts: { engine: "local" } });
  const router = new SpeechRouter(config, { synthesize, dispose() {} }, send, log, remove,
    { changed, voiceFor: (_, role) => config.tts.voices[role] });
  routers.push(router);
  const speaks = () => send.mock.calls.map(([event]) => event).filter(event => ["speak", "play-audio"].includes(event.type));
  const say = (characterId: string, text = "Полная реплика без потери текста.") => router.event({ type: "speak", characterId, text });
  const finish = () => router.receive({ type: "audio-finished", id: speaks().at(-1).audioId, phase: "end" });
  const ready = async (index: number) => {
    pending[index]!.resolve({ path: `/audio/${index}.wav`, duration: 60, sampleRate: 24000 });
    await vi.advanceTimersByTimeAsync(0);
  };
  return { router, pending, synthesize, send, remove, changed, log, speaks, say, finish, ready };
}

describe("local speech latency", () => {
  it("allows the measured cold start but bounds initial silence without losing the phrase", async () => {
    const t = setup(); t.say("a");
    await vi.advanceTimersByTimeAsync(16_000);
    expect(t.speaks()).toHaveLength(0);
    expect(t.changed).toHaveBeenLastCalledWith(new Set(["a"]), undefined);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.speaks()).toEqual([expect.objectContaining({ type: "speak", characterId: "a", text: "Полная реплика без потери текста." })]);
    expect(t.changed).toHaveBeenLastCalledWith(new Set(["a"]), "a");
  });
  it("times only the silent gap, leaves playback intact and does not reset the deadline on new text", async () => {
    const t = setup(); t.say("a"); t.say("b"); await t.ready(0);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(t.speaks()).toHaveLength(1);
    expect(t.send.mock.calls.some(([event]) => event.type === "stop")).toBe(false);
    t.finish(); await vi.advanceTimersByTimeAsync(19_000); t.say("c");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.speaks().at(-1)).toMatchObject({ type: "speak", characterId: "b" });
    expect(t.changed).toHaveBeenLastCalledWith(new Set(["b", "c"]), "b");
  });
  it("discards a late WAV once, then still prefetches and plays the next local voice in order", async () => {
    const t = setup(); for (const id of ["a", "b", "c"]) t.say(id);
    await t.ready(0); t.finish(); await vi.advanceTimersByTimeAsync(20_000);
    const fallback = t.speaks().at(-1);
    expect(fallback).toMatchObject({ type: "speak", characterId: "b" });
    await t.ready(1);
    expect(t.remove.mock.calls.filter(([path]) => path === "/audio/1.wav")).toHaveLength(1);
    expect(t.synthesize).toHaveBeenCalledTimes(3);
    await t.ready(2);
    expect(t.speaks()).toHaveLength(2);
    t.finish();
    expect(t.speaks().at(-1)).toMatchObject({ type: "play-audio", characterId: "c", path: "/audio/2.wav" });
    t.router.receive({ type: "audio-finished", id: fallback.audioId, phase: "end" });
    expect(t.speaks()).toHaveLength(3);
  });
  it("uses local audio when it becomes ready within the gap budget", async () => {
    const t = setup(); t.say("a"); t.say("b"); await t.ready(0); t.finish();
    await vi.advanceTimersByTimeAsync(19_999); await t.ready(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.speaks().map(event => event.type)).toEqual(["play-audio", "play-audio"]);
  });
  it("does not let a late generation failure disable local prefetch after its phrase fell back", async () => {
    const t = setup(); for (const id of ["a", "b", "c"]) t.say(id);
    await t.ready(0); t.finish(); await vi.advanceTimersByTimeAsync(20_000);
    t.pending[1]!.reject(new Error("late model failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.synthesize).toHaveBeenCalledTimes(3);
    await t.ready(2); t.finish();
    expect(t.speaks().map(event => event.type)).toEqual(["play-audio", "speak", "play-audio"]);
    expect(t.log).toHaveBeenCalledTimes(1);
  });
  it("grants a full 20-second budget even immediately after the queue drained", async () => {
    const t = setup(); t.say("a"); await t.ready(0); t.finish();
    await vi.advanceTimersByTimeAsync(500); t.say("b");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.speaks()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(t.speaks().at(-1)).toMatchObject({ type: "speak", characterId: "b" });
  });
  it("allows a fresh generation budget after a genuinely quiet interval", async () => {
    const t = setup(); t.say("a"); await t.ready(0); t.finish();
    await vi.advanceTimersByTimeAsync(30_000); t.say("b");
    await vi.advanceTimersByTimeAsync(16_000);
    expect(t.speaks()).toHaveLength(1);
    await t.ready(1);
    expect(t.speaks().at(-1)).toMatchObject({ type: "play-audio", characterId: "b" });
  });
  it.each(["mute", "suspend", "stop", "dispose"])("cancels the silence deadline and cleans late audio on %s", async action => {
    const t = setup(); t.say("a"); t.say("b"); await t.ready(0); t.finish();
    await vi.advanceTimersByTimeAsync(1_000);
    if (action === "dispose") t.router.dispose();
    else t.router.receive({ type: "speech-control", action, muted: true, suspended: true });
    await vi.advanceTimersByTimeAsync(25_000); await t.ready(1);
    expect(t.speaks()).toHaveLength(1);
    expect(t.remove.mock.calls.filter(([path]) => path === "/audio/1.wav")).toHaveLength(1);
    expect(t.changed).toHaveBeenLastCalledWith(new Set(), undefined);
  });
  it("does not give a replacement task the cancelled task's old deadline", async () => {
    const t = setup(); t.say("old"); await vi.advanceTimersByTimeAsync(19_000);
    t.router.event({ type: "stop", characterId: "old" }); t.say("new");
    await vi.advanceTimersByTimeAsync(1_000); await t.ready(0);
    expect(t.speaks()).toHaveLength(0);
    await t.ready(1);
    expect(t.speaks().map(event => event.characterId)).toEqual(["new"]);
  });
});
