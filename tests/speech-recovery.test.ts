import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { SpeechRouter } from "../packages/companions/src/speech-router.js";

const live: SpeechRouter[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { live.splice(0).forEach(router => router.dispose()); vi.useRealTimers(); });
function setup(engine: "local" | "macos" = "macos") {
  const send = vi.fn(), log = vi.fn(), changed = vi.fn();
  const synthesize = vi.fn(async () => ({ path: "/audio/test.wav", duration: 1, sampleRate: 24000 }));
  const config = configSchema.parse({ tts: { engine } });
  const router = new SpeechRouter(config, { synthesize, dispose() {} }, send, log, async () => {},
    { changed, voiceFor: (_, role) => config.tts.voices[role] });
  live.push(router);
  const speaks = () => send.mock.calls.map(([event]) => event).filter(event => ["speak", "play-audio"].includes(event.type));
  return { router, send, log, synthesize, changed, speaks };
}

describe("speech recovery", () => {
  it("recreates a silent system synthesizer once without losing the phrase or accepting stale callbacks", async () => {
    const t = setup();
    for (const characterId of ["a", "b"]) t.router.event({ type: "speak", characterId, text: "Проверка." });
    const first = t.speaks()[0];
    await vi.advanceTimersByTimeAsync(15_001);
    const retry = t.speaks()[1];
    expect(retry).toMatchObject({ type: "speak", characterId: "a", text: first.text, resetVoice: true });
    expect(retry.audioId).not.toBe(first.audioId);
    for (const type of ["audio-started", "audio-finished"]) t.router.receive({ type, id: first.audioId, phase: "end" });
    expect(t.speaks()).toHaveLength(2);
    t.router.receive({ type: "audio-started", id: retry.audioId });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(t.speaks()).toHaveLength(2);
    expect(t.changed).toHaveBeenLastCalledWith(new Set(["a", "b"]), "a");
    t.router.receive({ type: "audio-finished", id: retry.audioId, phase: "end" });
    expect(t.speaks().at(-1)).toMatchObject({ characterId: "b" });
  });
  it("bounds retries if both system attempts never start, then advances the queue", async () => {
    const t = setup();
    for (const characterId of ["a", "b"]) t.router.event({ type: "speak", characterId, text: "Проверка." });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(t.speaks().map(event => event.characterId)).toEqual(["a", "a", "b"]);
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining("системный голос"));
  });
  it("retries a timed-out WAV instead of silently discarding it", async () => {
    const t = setup("local");
    t.router.event({ type: "speak", characterId: "a", text: "Не терять эту реплику." });
    await vi.advanceTimersByTimeAsync(11_001);
    expect(t.speaks().map(event => event.type)).toEqual(["play-audio", "speak"]);
    expect(t.speaks()[1]).toMatchObject({ text: "Не терять эту реплику." });
  });
  it("retries local synthesis on a new invocation instead of waiting for a global cooldown", async () => {
    const t = setup("local"); t.synthesize.mockRejectedValueOnce(new Error("generation failed"));
    t.router.event({ type: "speak", characterId: "a", text: "Первая фраза." });
    await vi.advanceTimersByTimeAsync(0);
    const first = t.speaks()[0];
    t.router.receive({ type: "audio-started", id: first.audioId });
    t.router.receive({ type: "audio-finished", id: first.audioId, phase: "end" });
    await vi.advanceTimersByTimeAsync(30_001);
    t.router.event({ type: "speak", characterId: "a", invocationId: "new-invocation", text: "Новая фраза." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.synthesize).toHaveBeenCalledTimes(2);
    expect(t.speaks().at(-1)).toMatchObject({ type: "play-audio" });
  });
  it("recovers unexpected system cancellation but does not recover a user Stop", () => {
    const t = setup();
    t.router.event({ type: "speak", characterId: "a", text: "Проверка." });
    t.router.receive({ type: "audio-finished", id: t.speaks()[0].audioId, phase: "cancel" });
    expect(t.speaks()).toHaveLength(2);
    const retry = t.speaks()[1];
    t.router.receive({ type: "speech-control", action: "stop" });
    t.router.receive({ type: "audio-finished", id: retry.audioId, phase: "cancel" });
    expect(t.speaks()).toHaveLength(2);
  });
});
