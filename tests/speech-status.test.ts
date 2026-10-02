import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { SpeechRouter } from "../packages/companions/src/speech-router.js";

const live: SpeechRouter[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { live.splice(0).forEach(router => router.dispose()); vi.useRealTimers(); });
function setup(engine: "local" | "macos" = "local") {
  const send = vi.fn(), status = vi.fn(), reset = vi.fn(async () => {}), remove = vi.fn(async () => {});
  const synthesize = vi.fn(async () => ({ path: "/audio/test.wav", duration: 1, sampleRate: 24000 }));
  const config = configSchema.parse({ tts: { engine } });
  const router = new SpeechRouter(config, { synthesize, reset, dispose() {} }, send, () => {}, remove,
    { changed() {}, voiceFor: (_, role) => config.tts.voices[role], status });
  live.push(router);
  const speak = (text = "Публичная фраза.") => router.event({ type: "speak", characterId: "agent", taskId: "task", text });
  const plays = () => send.mock.calls.map(([event]) => event).filter(event => ["speak", "play-audio"].includes(event.type));
  const latest = () => status.mock.calls.at(-1)?.[0];
  const native = (type: string, phase?: string) => router.receive({ type, id: plays().at(-1)?.audioId, phase });
  return { router, send, status, reset, remove, synthesize, speak, plays, latest, native };
}

describe("voice self-diagnostics and explicit recovery", () => {
  it("distinguishes absent text, synthesis, queued audio and actual local playback", async () => {
    const t = setup();
    expect(t.latest()).toMatchObject({ phase: "idle", pending: 0, canRecover: false });
    t.router.event({ type: "state", characterId: "agent", state: "thinking" });
    expect(t.latest().phase).toBe("idle");
    let complete!: (audio: { path: string; duration: number; sampleRate: number }) => void;
    t.synthesize.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    t.speak(); expect(t.latest()).toMatchObject({ phase: "synthesizing", pending: 1 });
    complete({ path: "/audio/ready.wav", duration: 1, sampleRate: 24000 }); await vi.advanceTimersByTimeAsync(0);
    expect(t.latest()).toMatchObject({ phase: "queued", pending: 1 });
    t.native("audio-started"); expect(t.latest()).toMatchObject({ phase: "local", pending: 0 });
    t.native("audio-finished", "end"); expect(t.latest()).toMatchObject({ phase: "idle", pending: 0 });
  });
  it("explains fallback and restores only future speech after a failure, never replaying old text", async () => {
    const t = setup(); t.synthesize.mockRejectedValueOnce(new Error("private raw error and text"));
    t.speak(); await vi.advanceTimersByTimeAsync(0);
    expect(t.latest()).toMatchObject({ phase: "queued", reason: "local-unavailable", canRecover: false });
    t.native("audio-started"); expect(t.latest()).toMatchObject({ phase: "system", reason: "local-unavailable" });
    t.router.receive({ type: "speech-control", action: "recover" }); expect(t.reset).not.toHaveBeenCalled();
    t.native("audio-finished", "end"); expect(t.latest()).toMatchObject({ phase: "idle", canRecover: true });
    t.router.receive({ type: "speech-control", action: "recover" }); await vi.advanceTimersByTimeAsync(0);
    expect(t.reset).toHaveBeenCalledOnce(); expect(t.plays()).toHaveLength(1);
    expect(t.send).toHaveBeenCalledWith({ type: "reset-speech" });
    expect(t.latest()).toMatchObject({ phase: "idle", reason: "restored", canRecover: false });
    t.speak("Следующая реплика."); await vi.advanceTimersByTimeAsync(0);
    expect(t.synthesize).toHaveBeenCalledTimes(2); expect(t.plays().at(-1).type).toBe("play-audio");
    expect(JSON.stringify(t.status.mock.calls)).not.toMatch(/private|Публичная|Следующая/);
  });
  it("reports exhausted system recovery, while healthy playback cannot be manually reset", async () => {
    const t = setup("macos"); t.speak();
    t.native("audio-started"); expect(t.latest()).toMatchObject({ phase: "system", reason: "system-selected" });
    t.router.receive({ type: "speech-control", action: "recover" }); expect(t.reset).not.toHaveBeenCalled();
    t.native("audio-finished", "error"); t.native("audio-finished", "error");
    expect(t.latest()).toMatchObject({ phase: "error", pending: 0, reason: "system-unavailable", canRecover: true });
    t.router.receive({ type: "speech-control", action: "recover" }); await vi.advanceTimersByTimeAsync(0);
    expect(t.plays()).toHaveLength(2); expect(t.latest().reason).toBe("restored");
  });
  it("preserves mute and dictation controls and does not recover or resume cancelled text", async () => {
    const t = setup("macos"); t.speak(); t.native("audio-finished", "error"); t.native("audio-finished", "error");
    for (const [action, flag, phase] of [["mute", "muted", "muted"], ["suspend", "suspended", "dictating"]]) {
      t.router.receive({ type: "speech-control", action, [flag]: true });
      expect(t.latest()).toMatchObject({ phase, pending: 0, canRecover: false });
      t.router.receive({ type: "speech-control", action: "recover" }); expect(t.reset).not.toHaveBeenCalled();
      t.router.receive({ type: "speech-control", action, [flag]: false });
    }
    expect(t.plays()).toHaveLength(2);
  });
  it("discards late WAVs from a recovered failure without clearing newer synthesis or duplicating speech", async () => {
    const t = setup(); let old!: (audio: { path: string; duration: number; sampleRate: number }) => void;
    t.synthesize.mockImplementationOnce(() => new Promise(resolve => { old = resolve; }));
    t.speak(); await vi.advanceTimersByTimeAsync(20_001);
    expect(t.latest().reason).toBe("local-slow");
    t.native("audio-finished", "error"); t.native("audio-finished", "error");
    t.router.receive({ type: "speech-control", action: "recover" }); await vi.advanceTimersByTimeAsync(0);
    t.speak("Новая задача."); await vi.advanceTimersByTimeAsync(0);
    expect(t.synthesize).toHaveBeenCalledTimes(2);
    old({ path: "/audio/stale.wav", duration: 1, sampleRate: 24000 }); await vi.advanceTimersByTimeAsync(0);
    expect(t.remove).toHaveBeenCalledWith("/audio/stale.wav");
    expect(t.plays().map(event => event.type)).toEqual(["speak", "speak", "play-audio"]);
  });
  it("can reset a stalled local voice after fallback drains and grants the new worker a cold-start budget", async () => {
    const t = setup(); t.synthesize.mockImplementationOnce(() => new Promise(() => {}));
    t.speak(); await vi.advanceTimersByTimeAsync(20_001);
    t.native("audio-started"); t.native("audio-finished", "end");
    expect(t.latest()).toMatchObject({ reason: "local-slow", canRecover: true });
    t.router.receive({ type: "speech-control", action: "recover" }); await vi.advanceTimersByTimeAsync(0);
    let done!: (audio: { path: string; duration: number; sampleRate: number }) => void;
    t.synthesize.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    t.speak("Новая реплика после восстановления."); await vi.advanceTimersByTimeAsync(8_000);
    expect(t.plays()).toHaveLength(1); expect(t.latest().phase).toBe("synthesizing");
    done({ path: "/audio/recovered.wav", duration: 1, sampleRate: 24000 }); await vi.advanceTimersByTimeAsync(0);
    expect(t.plays().at(-1).type).toBe("play-audio");
  });
});
