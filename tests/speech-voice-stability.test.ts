import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { SpeechRouter } from "../packages/companions/src/speech-router.js";

type Audio = { path: string; duration: number; sampleRate: number };
const routers: SpeechRouter[] = [];
const longReply = ["А", "Б", "В"].map(letter => letter.repeat(250) + ".").join(" ");
beforeEach(() => vi.useFakeTimers());
afterEach(() => { routers.splice(0).forEach(router => router.dispose()); vi.useRealTimers(); });
function setup() {
  const pending: { resolve: (audio: Audio) => void; reject: (error: Error) => void }[] = [];
  const synthesize = vi.fn(() => new Promise<Audio>((resolve, reject) => pending.push({ resolve, reject })));
  const voiceFor = vi.fn(() => "Vivian"), send = vi.fn(), remove = vi.fn(async () => {});
  const router = new SpeechRouter(configSchema.parse({ tts: { engine: "local" } }), { synthesize, dispose() {} },
    send, () => {}, remove, { changed() {}, voiceFor });
  routers.push(router);
  const speaks = () => send.mock.calls.map(([event]) => event).filter(event => ["speak", "play-audio"].includes(event.type));
  const finish = () => router.receive({ type: "audio-finished", id: speaks().at(-1).audioId, phase: "end" });
  const ready = async (index: number) => {
    pending[index]!.resolve({ path: `/audio/${index}.wav`, duration: 10, sampleRate: 24000 });
    await vi.advanceTimersByTimeAsync(0);
  };
  const say = (text = longReply) => router.event({ type: "speak", characterId: "a", role: "developer", text });
  return { router, pending, synthesize, voiceFor, send, remove, speaks, finish, ready, say };
}

describe("speech voice stability", () => {
  it("keeps a single voice snapshot across every chunk when the character changes role mid-reply", async () => {
    const t = setup(); t.say(); await t.ready(0);
    t.voiceFor.mockReturnValue("Sohee");
    await t.ready(1); t.finish(); await t.ready(2); t.finish(); t.finish();
    expect(t.synthesize.mock.calls.map(([request]) => request.voice)).toEqual(["Vivian", "Vivian", "Vivian"]);
    expect(t.voiceFor).toHaveBeenCalledTimes(1);
    t.say("Теперь новое сообщение в новой роли.");
    expect(t.synthesize.mock.calls.at(-1)?.[0]).toMatchObject({ voice: "Sohee" });
  });
  it("keeps the rest of a reply on macOS after a latency fallback, then retries Qwen for a new reply", async () => {
    const t = setup(); t.say(); await t.ready(0); t.finish();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.speaks().at(-1)).toMatchObject({ type: "speak" });
    await t.ready(1);
    expect(t.synthesize).toHaveBeenCalledTimes(2);
    expect(t.remove).toHaveBeenCalledWith("/audio/1.wav");
    t.finish(); t.finish();
    expect(t.speaks().map(event => event.type)).toEqual(["play-audio", "speak", "speak"]);
    t.say("Новая публичная реплика.");
    expect(t.synthesize).toHaveBeenCalledTimes(3);
    await t.ready(2);
    expect(t.speaks().at(-1)).toMatchObject({ type: "play-audio" });
  });
  it("discards a ready prefetch from the same reply after a playback error instead of switching back", async () => {
    const t = setup(); t.say(); await t.ready(0); await t.ready(1);
    t.router.receive({ type: "audio-finished", id: t.speaks()[0].audioId, phase: "error" });
    expect(t.remove.mock.calls.map(([path]) => path).sort()).toEqual(["/audio/0.wav", "/audio/1.wav"]);
    t.finish(); t.finish(); t.finish();
    expect(t.speaks().map(event => event.type)).toEqual(["play-audio", "speak", "speak", "speak"]);
    expect(t.synthesize).toHaveBeenCalledTimes(2);
  });
  it("does not switch a long fallback reply back to Qwen when the failure cooldown expires", async () => {
    const t = setup(); t.say(); t.pending[0]!.reject(new Error("generation failed"));
    await vi.advanceTimersByTimeAsync(0);
    t.router.receive({ type: "audio-started", id: t.speaks()[0].audioId });
    await vi.advanceTimersByTimeAsync(31_000); t.finish();
    expect(t.speaks().at(-1)).toMatchObject({ type: "speak" });
    expect(t.synthesize).toHaveBeenCalledTimes(1);
  });
});
