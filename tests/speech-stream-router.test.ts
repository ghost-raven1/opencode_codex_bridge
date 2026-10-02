import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { CompanionDirector, type CompanionEvent } from "../packages/companions/src/director.js";
import { CompanionLifecycle } from "../packages/companions/src/lifecycle.js";
import { SpeechRouter } from "../packages/companions/src/speech-router.js";
import type { LocalSpeechRequest, LocalSpeechStreamObserver } from "../packages/companions/src/speech-stream.js";

const live: SpeechRouter[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { live.splice(0).forEach(router => router.dispose()); vi.useRealTimers(); });
function setup() {
  const requests: { request: LocalSpeechRequest; observer: LocalSpeechStreamObserver; signal?: AbortSignal;
    resolve(): void; reject(error?: Error): void }[] = [];
  const stream = vi.fn((request: LocalSpeechRequest, observer: LocalSpeechStreamObserver, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => requests.push({ request, observer, signal, resolve, reject })));
  const synthesize = vi.fn(async () => ({ path: "/legacy.wav", duration: 1, sampleRate: 24_000 }));
  const consumed = vi.fn(), reset = vi.fn(async () => {}), send = vi.fn(), remove = vi.fn(async () => {});
  const changed = vi.fn(), status = vi.fn(), diagnostic = vi.fn();
  const router = new SpeechRouter(configSchema.parse({ tts: { engine: "local" } }),
    { stream, synthesize, consumed, reset, dispose() {} }, send, () => {}, remove,
    { changed, status, voiceFor: () => "Vivian" }, diagnostic);
  live.push(router);
  const say = (characterId = "a", invocationId = "task-a", text = "Полная публичная реплика.") =>
    router.event({ type: "speak", characterId, invocationId, text });
  const events = (type: string) => send.mock.calls.map(([event]) => event).filter(event => event.type === type);
  const native = (type: string, request = 0, fields: Record<string, unknown> = {}) =>
    router.receive({ type, id: requests[request]!.request.id, ...fields });
  const chunk = (request = 0, index = 0, duration = 2) => requests[request]!.observer.chunk({ index,
    path: `/audio/${request}-${index}.wav`, duration, sampleRate: 24_000 });
  const end = async (request = 0) => { requests[request]!.resolve(); await vi.advanceTimersByTimeAsync(0); };
  return { router, requests, stream, synthesize, consumed, reset, send, remove, changed, status, diagnostic, say, events, native, chunk, end };
}

describe("streaming voice routing", () => {
  it("plays a single stream incrementally; deletes WAV after PCM acceptance but credits only after playback", async () => {
    const t = setup(); t.say();
    expect(t.events("caption")).toHaveLength(1); expect(t.events("audio-stream-start")).toHaveLength(1);
    expect(t.synthesize).not.toHaveBeenCalled();
    t.chunk(); t.chunk(0, 1);
    expect(t.events("audio-stream-chunk")).toHaveLength(2);
    expect(t.remove).not.toHaveBeenCalled(); expect(t.consumed).not.toHaveBeenCalled();
    t.native("audio-chunk-accepted", 0, { index: 0 }); t.native("audio-chunk-accepted", 0, { index: 0 });
    expect(t.remove).toHaveBeenCalledExactlyOnceWith("/audio/0-0.wav"); expect(t.consumed).not.toHaveBeenCalled();
    t.native("audio-started");
    expect(t.status.mock.calls.at(-1)?.[0].phase).toBe("local");
    t.native("audio-chunk-consumed", 0, { index: 0 }); t.native("audio-chunk-consumed", 0, { index: 0 });
    expect(t.consumed).toHaveBeenCalledExactlyOnceWith(t.requests[0]!.request.id, 0);
    await t.end();
    expect(t.events("audio-stream-end")).toEqual([expect.objectContaining({ chunks: 2 })]);
    t.native("audio-finished", 0, { phase: "end" });
    expect(t.changed).toHaveBeenLastCalledWith(new Set(), undefined);
    expect(t.remove).toHaveBeenCalledTimes(2); expect(t.consumed).toHaveBeenCalledTimes(2);
    expect(t.events("caption")).toHaveLength(1);
  });
  it("prefetches only the next utterance in TS and never sends two simultaneous native streams", async () => {
    const t = setup(); t.say(); t.say("b", "task-b"); t.say("c", "task-c");
    t.chunk(); t.native("audio-started"); await t.end();
    expect(t.requests).toHaveLength(2); t.chunk(1); await t.end(1);
    expect(t.events("audio-stream-start")).toHaveLength(1); expect(t.events("audio-stream-chunk")).toHaveLength(1);
    expect(t.requests).toHaveLength(2); expect(t.remove).not.toHaveBeenCalled();
    t.native("audio-finished", 0, { phase: "end" });
    expect(t.events("audio-stream-start")).toHaveLength(2); expect(t.events("audio-stream-chunk")).toHaveLength(2);
    expect(t.requests).toHaveLength(3);
    expect(t.events("audio-stream-start").map(event => event.characterId)).toEqual(["a", "b"]);
  });
  it("holds lifecycle pending until generation end AND native final, including reversed delivery", async () => {
    const t = setup(); t.say(); t.chunk(); t.native("audio-started");
    t.native("audio-finished", 0, { phase: "end" });
    expect(t.changed).toHaveBeenLastCalledWith(new Set(["a"]), "a");
    await t.end(); expect(t.changed).toHaveBeenLastCalledWith(new Set(), undefined);
    t.say("b", "task-b"); t.chunk(1); await t.end(1);
    expect(t.changed).toHaveBeenLastCalledWith(new Set(["b"]), "b");
    t.native("audio-finished", 1, { phase: "end" });
    expect(t.changed).toHaveBeenLastCalledWith(new Set(), undefined);
  });
  it("forces a partial prefill at20s, then does not time out healthy ongoing PCM at30s", async () => {
    const t = setup(); t.say(); t.chunk();
    await vi.advanceTimersByTimeAsync(19_999); expect(t.events("audio-stream-play")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); expect(t.events("audio-stream-play")).toHaveLength(1);
    expect(t.events("speak")).toHaveLength(0); t.native("audio-started");
    await vi.advanceTimersByTimeAsync(12_000); expect(t.events("speak")).toHaveLength(0);
    expect(t.requests[0]!.signal!.aborted).toBe(false);
  });
  it("falls back with the whole text if20s yields no PCM, aborts generation and ignores late chunks", async () => {
    const t = setup(); t.say(); await vi.advanceTimersByTimeAsync(20_000);
    expect(t.events("speak")).toEqual([expect.objectContaining({ text: "Полная публичная реплика." })]);
    expect(t.requests[0]!.signal!.aborted).toBe(true);
    t.chunk(); expect(t.events("audio-stream-chunk")).toHaveLength(0);
    expect(t.remove).toHaveBeenCalledWith("/audio/0-0.wav");
    expect(t.consumed).toHaveBeenCalledWith(t.requests[0]!.request.id, 0);
    await t.end(); expect(t.events("speak")).toHaveLength(1);
  });
  it("grants prefetched work a fresh20s only after it becomes eligible", async () => {
    const t = setup(); t.say(); t.say("b", "task-b");
    t.chunk(); t.native("audio-started"); await t.end();
    await vi.advanceTimersByTimeAsync(25_000); expect(t.events("speak")).toHaveLength(0);
    t.native("audio-finished", 0, { phase: "end" });
    await vi.advanceTimersByTimeAsync(19_999); expect(t.events("speak")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); expect(t.events("speak").at(-1)).toMatchObject({ characterId: "b" });
  });
  it("falls back before the first audible sample but never repeats an already audible fragment", async () => {
    const t = setup(); t.say(); t.chunk();
    t.native("audio-finished", 0, { phase: "error" });
    expect(t.events("speak")).toHaveLength(1);
    t.router.receive({ type: "audio-finished", id: t.events("speak")[0].audioId, phase: "end" });
    await t.end();
    t.say("b", "task-b"); t.chunk(1); t.native("audio-started", 1);
    t.native("audio-finished", 1, { phase: "error" });
    expect(t.events("speak")).toHaveLength(1);
    expect(t.status.mock.calls.at(-1)?.[0]).toMatchObject({ reason: "partial-stream-failure", canRecover: true });
    expect(t.events("caption")).toHaveLength(2);
    t.say("b", "task-b", "Следующий фрагмент.");
    expect(t.events("speak").at(-1)).toMatchObject({ text: "Следующий фрагмент." });
    expect(t.events("audio-stream-start")).toHaveLength(2);
  });
  it("treats producer failure after audio-started as a partial failure without replay", async () => {
    const t = setup(); t.say(); t.chunk(); t.native("audio-started");
    t.requests[0]!.reject(new Error("producer failed")); await vi.advanceTimersByTimeAsync(0);
    expect(t.events("speak")).toHaveLength(0); expect(t.events("stop")).toHaveLength(1);
    t.say(); expect(t.events("speak")).toHaveLength(1);
  });
  it("waits10s on an empty buffer, resets when playback recovers, and fails once on a sustained stall", async () => {
    const t = setup(); t.say(); t.chunk(); t.native("audio-started");
    t.native("audio-buffering", 0, { buffering: true, bufferedSeconds: 0 });
    expect(t.status.mock.calls.at(-1)?.[0].phase).toBe("buffering");
    await vi.advanceTimersByTimeAsync(9_000);
    t.native("audio-buffering", 0, { buffering: false, bufferedSeconds: 2 });
    await vi.advanceTimersByTimeAsync(9_000); expect(t.events("stop")).toHaveLength(0);
    t.native("audio-buffering", 0, { buffering: true, bufferedSeconds: 0 });
    await vi.advanceTimersByTimeAsync(9_000);
    t.native("audio-buffering", 0, { buffering: true, bufferedSeconds: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.requests[0]!.signal!.aborted).toBe(true); expect(t.events("speak")).toHaveLength(0);
    expect(t.events("stop")).toHaveLength(1);
    t.native("audio-finished", 0, { phase: "error" }); expect(t.events("stop")).toHaveLength(1);
  });
  it.each(["stop", "mute", "suspend", "dispose"])("cancels active and prefetched PCM on%s, returns credits once and discards late output", async action => {
    const t = setup(); t.say(); t.say("b", "task-b"); t.chunk(); t.native("audio-started"); await t.end(); t.chunk(1);
    t.native("audio-chunk-accepted", 0, { index: 0 });
    if (action === "dispose") t.router.dispose();
    else t.router.receive({ type: "speech-control", action, muted: true, suspended: true });
    expect(t.requests[1]!.signal!.aborted).toBe(true);
    expect(t.remove).toHaveBeenCalledTimes(2); expect(t.consumed).toHaveBeenCalledTimes(2);
    t.chunk(1, 1); await t.end(1);
    expect(t.remove).toHaveBeenCalledTimes(3); expect(t.consumed).toHaveBeenCalledTimes(3);
    t.native("audio-chunk-consumed", 0, { index: 0 });
    expect(t.consumed).toHaveBeenCalledTimes(3);
    expect(t.events("audio-stream-start")).toHaveLength(1);
    expect(t.changed).toHaveBeenLastCalledWith(new Set(), undefined);
  });
  it("keeps macOS locked across messages/compaction and unlocks only a new invocation or idle explicit recovery", async () => {
    const t = setup(); t.say(); t.requests[0]!.reject(); await vi.advanceTimersByTimeAsync(0);
    const finishSystem = () => t.router.receive({ type: "audio-finished", id: t.events("speak").at(-1).audioId, phase: "end" });
    finishSystem(); await vi.advanceTimersByTimeAsync(60_000);
    t.router.event({ type: "state", characterId: "a", taskId: "synthetic-parent", invocationId: "task-a", state: "working" });
    t.say(); expect(t.stream).toHaveBeenCalledTimes(1); finishSystem();
    t.router.receive({ type: "speech-control", action: "recover" }); await vi.advanceTimersByTimeAsync(0);
    expect(t.reset).toHaveBeenCalledOnce(); t.say(); expect(t.stream).toHaveBeenCalledTimes(2);
    t.requests[1]!.reject(); await vi.advanceTimersByTimeAsync(0); finishSystem();
    t.say("a", "task-next"); expect(t.stream).toHaveBeenCalledTimes(3);
  });
  it("does not lock another agent when prefetched synthesis fails", async () => {
    const t = setup(); t.say(); t.say("b", "task-b"); t.chunk(); t.native("audio-started"); await t.end();
    t.requests[1]!.reject(); await vi.advanceTimersByTimeAsync(0);
    expect(t.events("stop")).toHaveLength(0); expect(t.events("speak")).toHaveLength(0);
    t.native("audio-finished", 0, { phase: "end" });
    expect(t.events("speak").at(-1)).toMatchObject({ characterId: "b" });
    t.say(); expect(t.stream).toHaveBeenCalledTimes(3);
  });
  it.each(["generation", "partial"])("keeps idle recovery after %s failure when another agent successfully speaks locally", async failure => {
    const t = setup(); t.say();
    if (failure === "partial") { t.chunk(); t.native("audio-started"); }
    t.requests[0]!.reject(); await vi.advanceTimersByTimeAsync(0);
    if (failure === "partial") t.say();
    t.router.receive({ type: "audio-finished", id: t.events("speak")[0].audioId, phase: "end" });
    t.say("b", "task-b"); t.chunk(1); t.native("audio-started", 1);
    expect(t.status.mock.calls.at(-1)?.[0]).toEqual({ phase: "local", pending: 0, canRecover: false });
    await t.end(1); t.native("audio-finished", 1, { phase: "end" });
    expect(t.status.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "idle",
      reason: failure === "partial" ? "partial-stream-failure" : "local-unavailable", canRecover: true });
    for (const [action, flag, phase] of [["mute", "muted", "muted"], ["suspend", "suspended", "dictating"]]) {
      t.router.receive({ type: "speech-control", action, [flag]: true });
      expect(t.status.mock.calls.at(-1)?.[0]).toMatchObject({ phase, canRecover: false });
      t.router.receive({ type: "speech-control", action: "recover" }); expect(t.reset).not.toHaveBeenCalled();
      t.router.receive({ type: "speech-control", action, [flag]: false });
    }
    t.router.receive({ type: "speech-control", action: "recover" }); await vi.advanceTimersByTimeAsync(0);
    expect(t.reset).toHaveBeenCalledOnce();
    expect(t.status.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "idle", reason: "restored", canRecover: false });
    t.say(); expect(t.stream).toHaveBeenCalledTimes(3);
  });
  it("falls back on an empty completed stream instead of leaving an immortal pending character", async () => {
    const t = setup(); t.say(); await t.end();
    expect(t.events("speak")).toHaveLength(1); expect(t.events("audio-stream-end")).toHaveLength(0);
  });
});

describe("speech invocation propagation", () => {
  it("keeps the fallback lock when the real director processes a synthetic compaction continuation", async () => {
    const t = setup();
    const life = new CompanionLifecycle(configSchema.parse({}), event => t.router.event(event));
    const director = new CompanionDirector(configSchema.parse({}), event => life.event(event));
    const info = (id: string, role: string, extra = {}) => director.event({ type: "message.updated", properties: {
      info: { sessionID: "a", id, role, ...extra },
    } });
    const text = (id: string, messageID: string, value: string, extra = {}) => director.event({ type: "message.part.updated", properties: {
      part: { sessionID: "a", id, messageID, type: "text", text: value, time: { end: 1 }, ...extra },
    } });
    director.assignTask("a", { task: "Напиши код", messageID: "u" }); info("u", "user");
    info("first", "assistant", { parentID: "u" }); text("p1", "first", "Первая фраза.");
    t.requests[0]!.reject(); await vi.advanceTimersByTimeAsync(0);
    t.router.receive({ type: "audio-finished", id: t.events("speak")[0].audioId, phase: "end" });
    info("summary", "assistant", { parentID: "u", mode: "compaction", summary: true });
    text("summary-part", "summary", "Служебное резюме"); info("synthetic", "user");
    text("continuation", "synthetic", "Continue", { synthetic: true });
    info("next", "assistant", { parentID: "synthetic" }); text("p2", "next", "Продолжаю исходную задачу.");
    expect(t.stream).toHaveBeenCalledTimes(1);
    expect(t.events("speak").map(event => event.text)).toEqual(["Первая фраза.", "Продолжаю исходную задачу."]);
    life.dispose();
  });
  it("preserves a child's invocation in public speech through repeated metadata and changes it for real new tasks", () => {
    const emitted: CompanionEvent[] = [];
    const life = new CompanionLifecycle(configSchema.parse({}), event => emitted.push(event));
    const director = new CompanionDirector(configSchema.parse({}), event => life.event(event));
    const user = (id: string) => {
      director.event({ type: "message.updated", properties: { info: { sessionID: "child", id, role: "user" } } });
      director.event({ type: "message.part.updated", properties: { part: { sessionID: "child", id: `part-${id}`, messageID: id, type: "text", text: "Проверь код" } } });
    };
    director.assignTask("child", { parentID: "parent", agent: "review", task: "Проверь код" }); user("u1");
    const invocation = emitted.find(event => event.type === "state")!.invocationId;
    director.assignTask("child", { parentID: "parent", agent: "review", task: "Проверь код" });
    expect(director.introduce("child", "u1", "Проверю изменения.")).toBe(true);
    expect(emitted.find(event => event.type === "speak")?.invocationId).toBe(invocation);
    user("u2");
    expect(emitted.filter(event => event.type === "state").at(-1)?.invocationId).not.toBe(invocation);
    life.dispose();
  });
});
