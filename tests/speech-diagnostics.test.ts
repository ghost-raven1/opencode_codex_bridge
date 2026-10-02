import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { CompanionLifecycle } from "../packages/companions/src/lifecycle.js";
import { SpeechRouter } from "../packages/companions/src/speech-router.js";
const routers: SpeechRouter[] = [], lifecycles: CompanionLifecycle[] = [];
afterEach(() => { routers.splice(0).forEach(router => router.dispose()); lifecycles.splice(0).forEach(life => life.dispose()); vi.useRealTimers(); });

describe("speech diagnostic instrumentation", () => {
  it("records fallback/late audio/lifecycle timings without exposing the spoken text", async () => {
    vi.useFakeTimers();
    const diagnostic = vi.fn(), send = vi.fn(), remove = vi.fn(async () => {}), config = configSchema.parse({ tts: { engine: "local" } });
    let resolve!: (audio: { path: string; duration: number; sampleRate: number }) => void;
    const generated = new Promise<{ path: string; duration: number; sampleRate: number }>(done => { resolve = done; });
    const life = new CompanionLifecycle(config, event => router.event(event), diagnostic); lifecycles.push(life);
    const router = new SpeechRouter(config, { synthesize: () => generated, dispose() {} }, send, () => {}, remove,
      { changed: (pending, speaker) => life.speechActivity(pending, speaker), voiceFor: () => "Vivian" }, diagnostic); routers.push(router);
    life.event({ type: "state", characterId: "agent", taskId: "task", role: "developer", state: "working" });
    life.event({ type: "speak", characterId: "agent", taskId: "task", role: "developer", text: "SECRET full spoken phrase" });
    life.event({ type: "state", characterId: "agent", taskId: "task", role: "developer", state: "success" });
    await vi.advanceTimersByTimeAsync(20_000);
    const fallback = send.mock.calls.map(([event]) => event).find(event => event.type === "speak");
    expect(fallback).toBeDefined();
    expect(send.mock.calls.some(([event]) => event.type === "remove")).toBe(false);
    expect(diagnostic).toHaveBeenCalledWith("speech-fallback", expect.objectContaining({ reason: "latency-budget", waitMs: 20_000, taskId: "task" }));
    router.receive({ type: "audio-started", id: fallback.audioId }); await vi.advanceTimersByTimeAsync(500);
    router.receive({ type: "audio-finished", id: fallback.audioId, phase: "end" });
    expect(diagnostic).toHaveBeenCalledWith("speech-end", expect.objectContaining({ elapsedMs: 500, phase: "end" }));
    resolve({ path: "/private/SECRET.wav", duration: 1, sampleRate: 24000 }); await vi.advanceTimersByTimeAsync(0);
    expect(diagnostic).toHaveBeenCalledWith("synthesis-discard", expect.objectContaining({ reason: "stale-audio" }));
    expect(remove).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(diagnostic).toHaveBeenCalledWith("lifecycle-remove", expect.objectContaining({ reason: "retired", taskId: "task" }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("SECRET");
  });
  it("records the actual local playback start and end, not only the command being sent", async () => {
    vi.useFakeTimers(); const diagnostic = vi.fn(), send = vi.fn();
    const router = new SpeechRouter(configSchema.parse({ tts: { engine: "local" } }), { synthesize: async () => ({ path: "/tmp/voice.wav", duration: 1, sampleRate: 24000 }), dispose() {} },
      send, () => {}, async () => {}, undefined, diagnostic); routers.push(router);
    router.event({ type: "speak", characterId: "a", text: "SECRET" }); await vi.advanceTimersByTimeAsync(0);
    const play = send.mock.calls.map(([event]) => event).find(event => event.type === "play-audio");
    expect(diagnostic.mock.calls.some(([event]) => event === "speech-start")).toBe(false);
    router.receive({ type: "audio-started", id: play.audioId }); await vi.advanceTimersByTimeAsync(750);
    router.receive({ type: "audio-finished", id: play.audioId, phase: "end" });
    expect(diagnostic).toHaveBeenCalledWith("speech-start", expect.objectContaining({ engine: "local" }));
    expect(diagnostic).toHaveBeenCalledWith("speech-end", expect.objectContaining({ elapsedMs: 750 }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("SECRET");
  });
});
