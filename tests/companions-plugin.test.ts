import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { configSchema } from "../packages/companions/src/config.js";
import { DictationDrafts } from "../packages/companions/src/dictation-drafts.js";

const mocks = vi.hoisted(() => ({
  receive: undefined as undefined | ((event: Record<string, unknown> & { type: string }) => void),
  send: vi.fn(), close: vi.fn(), synthesize: vi.fn(), disposeWorker: vi.fn(),
}));
vi.mock("node:fs/promises", async original => ({ ...await original<object>(), access: vi.fn(async () => {}) }));
vi.mock("../packages/companions/src/atlas.js", () => ({ validateAtlas: vi.fn(async () => { throw new Error("Missing atlas"); }) }));
vi.mock("../packages/companions/src/config.js", async original => ({ ...await original<object>(), readConfig: vi.fn() }));
vi.mock("../packages/companions/src/native-host.js", () => ({
  startNativeHost: vi.fn(async (_binary, _args, receive) => { mocks.receive = receive; return { send: mocks.send, close: mocks.close }; }),
}));
vi.mock("../packages/companions/src/local-tts.js", () => ({ LocalTts: class { synthesize = mocks.synthesize; dispose = mocks.disposeWorker; } }));
import Companions from "../packages/companions/src/plugin.js";
import { readConfig } from "../packages/companions/src/config.js";
import { startNativeHost } from "../packages/companions/src/native-host.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
Object.defineProperty(process, "platform", { value: "darwin" });
let dataRoot: string;
let live: Hooks[] = [];
const previousDataRoot = process.env.CODEXBRIDGE_DATA_DIR;
afterAll(() => { Object.defineProperty(process, "platform", platform); if (previousDataRoot) process.env.CODEXBRIDGE_DATA_DIR = previousDataRoot; else delete process.env.CODEXBRIDGE_DATA_DIR; });
beforeEach(async () => {
  vi.clearAllMocks(); mocks.receive = undefined; mocks.send.mockReset();
  mocks.synthesize.mockReset().mockResolvedValue({ path: "/project/.local/tts/audio/test.wav", duration: 1, sampleRate: 24000 });
  vi.mocked(readConfig).mockResolvedValue(configSchema.parse({ enabled: true }));
  dataRoot = await mkdtemp(join(tmpdir(), "cb-plugin-")); process.env.CODEXBRIDGE_DATA_DIR = dataRoot;
});
afterEach(async () => { for (const hooks of live) await hooks.dispose?.(); live = []; await rm(dataRoot, { recursive: true, force: true }); });
async function setup(directory = "/project") {
  const client = { app: { log: vi.fn(async () => ({})) }, tui: {
    appendPrompt: vi.fn(async () => ({})), submitPrompt: vi.fn(async () => ({})), showToast: vi.fn(async () => ({})),
    clearPrompt: vi.fn(async () => ({})), executeCommand: vi.fn(async () => ({})),
  } };
  const hooks = await Companions({ directory, client } as unknown as PluginInput); live.push(hooks);
  return { client, hooks };
}
async function task(hooks: Hooks, id = "u", text = "Напиши код") {
  await hooks["chat.message"]?.({ sessionID: "s", agent: "build" }, {
    message: { id, agent: "build" } as never, parts: [{ type: "text", text }] as never,
  });
  await hooks.event?.({ event: { type: "message.updated", properties: { info: { id, sessionID: "s", role: "user", agent: "build" } } } } as never);
}
const action = (hooks: Hooks, action: string) => hooks.tool!.companion!.execute({ action }, {} as never);

describe("CLI voice and durable drafts", () => {
  it("starts empty even with legacy showOnStart, retaining voice without artwork", async () => {
    vi.mocked(readConfig).mockResolvedValue(configSchema.parse({ enabled: true, showOnStart: true }));
    const t = await setup();
    expect(startNativeHost).toHaveBeenCalledOnce();
    expect(vi.mocked(startNativeHost).mock.calls[0]?.[1]).not.toContain("--preview");
    expect(mocks.send.mock.calls.some(([e]) => e.type === "state")).toBe(false);
    await task(t.hooks);
    expect(mocks.send.mock.calls.some(([event]) => event.type === "speak")).toBe(false);
  });
  it("asks the current role for a unique model opening and never repeats an accepted introduction", async () => {
    const t = await setup(); await task(t.hooks);
    const output = { system: ["Original system instruction"] };
    await t.hooks["experimental.chat.system.transform"]?.({ sessionID: "s", model: {} as never }, output);
    expect(output.system[0]).toBe("Original system instruction");
    expect(output.system[1]).toContain("CODE:");
    expect(output.system[1]).toContain("companion_intro");
    const named = mocks.send.mock.calls.find(([event]) => event.type === "state")![0];
    expect(named.name).toEqual(expect.any(String));
    expect(output.system[1]).toContain(`Имя этого персонажа — ${named.name}`);
    const context = { sessionID: "s", abort: new AbortController().signal } as never;
    expect(await t.hooks.tool!.companion_intro!.execute({ text: "Сейчас починим эту функцию, багам пора домой." }, context)).toContain("queued:");
    expect(await t.hooks.tool!.companion_intro!.execute({ text: "Лишнее вступление" }, context)).toContain("skipped:");
    await task(t.hooks, "u2");
    expect(await t.hooks.tool!.companion_intro!.execute({ text: "Сейчас починим эту функцию, багам пора домой!" }, context)).toContain("duplicate:");
    expect(await t.hooks.tool!.companion_intro!.execute({ text: "[Сейчас починим эту функцию, багам пора домой.](https://example.org)" }, context)).toContain("duplicate:");
    expect(await t.hooks.tool!.companion_intro!.execute({ text: "***" }, context)).toContain("invalid:");
    expect(await t.hooks.tool!.companion_intro!.execute({ text: "Проверим функцию заново, компилятор уже в первом ряду." }, context)).toContain("queued:");
    const fresh = { system: [] as string[] };
    await t.hooks["experimental.chat.system.transform"]?.({ sessionID: "s", model: {} as never }, fresh);
    expect(fresh.system).toEqual([]);
  });
  it("persists before publishing; success is not claimed as insertion and never submits", async () => {
    const t = await setup(); mocks.receive?.({ type: "transcript", text: "Проверь тесты" });
    await vi.waitFor(() => expect(t.client.tui.appendPrompt).toHaveBeenCalledOnce());
    expect(t.client.tui.appendPrompt).toHaveBeenCalledWith({ query: { directory: "/project" }, body: { text: "Проверь тесты " }, signal: expect.any(AbortSignal) });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: "drafts", items: [expect.objectContaining({ preview: "Проверь тесты" })] }));
    expect(t.client.tui.submitPrompt).not.toHaveBeenCalled();
    expect(t.client.tui.showToast).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ message: expect.stringContaining("Проверь строку ввода") }) }));
    await action(t.hooks, "recover_dictation"); expect(t.client.tui.appendPrompt).toHaveBeenCalledTimes(2);
  });
  it("retains failed delivery across restart and recovers only on explicit request", async () => {
    const t = await setup(); t.client.tui.appendPrompt.mockRejectedValueOnce(new Error("offline"));
    mocks.receive?.({ type: "transcript", text: "Сохрани черновик" });
    await vi.waitFor(() => expect(t.client.app.log).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ message: "Error: offline" }) })));
    await t.hooks.dispose?.(); const reopened = await setup();
    expect(reopened.client.tui.appendPrompt).not.toHaveBeenCalled();
    await action(reopened.hooks, "recover_dictation"); expect(reopened.client.tui.appendPrompt).toHaveBeenCalledOnce();
    await action(reopened.hooks, "clear_dictation");
    await expect(action(reopened.hooks, "recover_dictation")).rejects.toThrow("не найден");
  });
  it("keeps projects separate and allows native view/copy without submitting", async () => {
    const a = await setup(); mocks.receive?.({ type: "transcript", text: "Проект A" });
    await vi.waitFor(() => expect(a.client.tui.appendPrompt).toHaveBeenCalledOnce());
    const entry = mocks.send.mock.calls.filter(([e]) => e.type === "drafts").at(-1)![0].items[0];
    mocks.receive?.({ type: "draft-action", action: "copy", id: entry.id });
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith({ type: "draft-text", action: "copy", text: "Проект A" }));
    const b = await setup("/other"); await expect(action(b.hooks, "recover_dictation")).rejects.toThrow("не найден");
    expect(b.client.tui.appendPrompt).not.toHaveBeenCalled();
  });
  it("coalesces simultaneous recoveries without losing subsequent dictation", async () => {
    const t = await setup(); mocks.receive?.({ type: "transcript", text: "Первый" });
    await vi.waitFor(() => expect(t.client.tui.appendPrompt).toHaveBeenCalledOnce());
    let release!: (value: object) => void;
    t.client.tui.appendPrompt.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const a = action(t.hooks, "recover_dictation"), b = action(t.hooks, "recover_dictation");
    await vi.waitFor(() => expect(t.client.tui.appendPrompt).toHaveBeenCalledTimes(2));
    mocks.receive?.({ type: "transcript", text: "Второй" }); release({}); await Promise.all([a, b]);
    await vi.waitFor(() => expect(t.client.tui.appendPrompt).toHaveBeenCalledTimes(3));
  });
  it("persists new dictation while an earlier HTTP delivery is still pending", async () => {
    const t = await setup();
    let release!: (value: object) => void;
    t.client.tui.appendPrompt.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    mocks.receive?.({ type: "transcript", text: "Первая диктовка" });
    await vi.waitFor(() => expect(t.client.tui.appendPrompt).toHaveBeenCalledOnce());
    try {
      mocks.receive?.({ type: "transcript", text: "Вторая диктовка" });
      await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "drafts", items: expect.arrayContaining([
          expect.objectContaining({ preview: "Первая диктовка" }),
          expect.objectContaining({ preview: "Вторая диктовка" }),
        ]),
      })));
      const reopened = await DictationDrafts.open("/project", dataRoot);
      expect(reopened.list().map(draft => draft.text)).toEqual(["Первая диктовка", "Вторая диктовка"]);
      expect(t.client.tui.appendPrompt).toHaveBeenCalledOnce();
      expect(t.client.tui.submitPrompt).not.toHaveBeenCalled();
    } finally { release({}); }
    await vi.waitFor(() => expect(t.client.tui.appendPrompt).toHaveBeenCalledTimes(2));
    expect(t.client.tui.appendPrompt.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ body: { text: "Вторая диктовка " } }));
  });
  it("handles a failed task with missing output without obscuring its original error", async () => {
    const { hooks } = await setup();
    await expect(hooks["tool.execute.after"]?.({ tool: "task", sessionID: "s", callID: "c", args: {} }, undefined as never)).resolves.toBeUndefined();
  });
  it("routes task intention before the first message event and assigns actual child sessions", async () => {
    const { hooks } = await setup(); await task(hooks, "u", "Поищи баги и недоработки");
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: "state", role: "reviewer" }));
    await hooks["tool.execute.after"]?.({ tool: "task", sessionID: "s", callID: "c", args: { subagent_type: "general", description: "Research API docs" } },
      { title: "Research", output: "done", metadata: { sessionId: "child" } });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: "state", characterId: "child", role: "researcher" }));
  });
  it("quiet profile never starts a native process", async () => {
    vi.mocked(readConfig).mockResolvedValue(configSchema.parse({ enabled: false }));
    expect((await setup()).hooks).toEqual({}); expect(startNativeHost).not.toHaveBeenCalled();
  });
  it("disposes on close and reconnects explicitly, without replaying speech or dictation", async () => {
    vi.mocked(readConfig).mockResolvedValue(configSchema.parse({ enabled: true, workingPhrase: "Проверка озвучки", tts: { engine: "local" } }));
    const { hooks, client } = await setup(); await task(hooks);
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: "play-audio" })));
    mocks.receive?.({ type: "closed" }); expect(mocks.disposeWorker).toHaveBeenCalledOnce();
    await action(hooks, "show"); expect(startNativeHost).toHaveBeenCalledTimes(2);
    expect(mocks.synthesize).toHaveBeenCalledOnce(); expect(client.tui.appendPrompt).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith({ type: "show" });
  });
  it("disposes on failed audio send without interrupting the task", async () => {
    vi.mocked(readConfig).mockResolvedValue(configSchema.parse({ enabled: true, workingPhrase: "Проверка озвучки", tts: { engine: "local" } }));
    mocks.send.mockImplementation(e => { if (e.type === "play-audio") throw new Error("pipe closed"); });
    const { hooks } = await setup(); await expect(task(hooks)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(mocks.disposeWorker).toHaveBeenCalledOnce());
    await task(hooks, "next"); expect(mocks.synthesize).toHaveBeenCalledOnce();
  });
  it("toggles dictation availability without recording or submitting", async () => {
    const { hooks, client } = await setup(); mocks.send.mockClear();
    await action(hooks, "dictation_off"); await action(hooks, "dictation_on");
    expect(mocks.send.mock.calls.map(([e]) => e)).toEqual([{ type: "dictation-disable" }, { type: "dictation-enable" }]);
    expect(mocks.synthesize).not.toHaveBeenCalled(); expect(client.tui.appendPrompt).not.toHaveBeenCalled(); expect(client.tui.submitPrompt).not.toHaveBeenCalled();
  });
  it("saves dictated text before append and sends only after the explicit command is acknowledged", async () => {
    const { client } = await setup();
    let release!: (value: object) => void;
    client.tui.appendPrompt.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    mocks.receive?.({ type: "voice-command", command: "submit", text: "Проверь тесты" });
    await vi.waitFor(() => expect(client.tui.appendPrompt).toHaveBeenCalledOnce());
    expect((await DictationDrafts.open("/project", dataRoot)).list().at(-1)?.text).toBe("Проверь тесты");
    expect(client.tui.submitPrompt).not.toHaveBeenCalled();
    release({});
    await vi.waitFor(() => expect(client.tui.submitPrompt).toHaveBeenCalledOnce());
    expect(client.tui.submitPrompt).toHaveBeenCalledWith({ query: { directory: "/project" }, signal: expect.any(AbortSignal) });
  });
  it("does not submit stale input after a failed append, including a later standalone send command", async () => {
    const { client } = await setup();
    client.tui.appendPrompt.mockResolvedValueOnce({ error: "offline" });
    mocks.receive?.({ type: "voice-command", command: "submit", text: "Сохранить без потерь" });
    await vi.waitFor(() => expect(client.tui.appendPrompt).toHaveBeenCalledOnce());
    mocks.receive?.({ type: "voice-command", command: "submit" });
    await vi.waitFor(() => expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ message: expect.stringContaining("старый запрос не отправлен") }) })));
    expect(client.tui.submitPrompt).not.toHaveBeenCalled();
    expect((await DictationDrafts.open("/project", dataRoot)).list().at(-1)?.text).toBe("Сохранить без потерь");
  });
  it("orders a standalone send behind an immediately preceding transcript persistence and append", async () => {
    const { client } = await setup();
    mocks.receive?.({ type: "transcript", text: "Сначала сохранение" });
    mocks.receive?.({ type: "voice-command", command: "submit" });
    await vi.waitFor(() => expect(client.tui.submitPrompt).toHaveBeenCalledOnce());
    expect(client.tui.appendPrompt.mock.invocationCallOrder[0]).toBeLessThan(client.tui.submitPrompt.mock.invocationCallOrder[0]!);
    expect((await DictationDrafts.open("/project", dataRoot)).list().at(-1)?.text).toBe("Сначала сохранение");
  });
  it("routes controls without dictating their words and rejects unknown commands", async () => {
    const { client } = await setup(); mocks.send.mockClear();
    for (const command of ["cancel", "stop-speech", "hide", "show", "mute", "unmute", "disable-dictation", "help", "shell.delete"]) {
      mocks.receive?.({ type: "voice-command", command, text: "" });
    }
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(8));
    expect(mocks.send.mock.calls.map(([event]) => event)).toEqual([
      { type: "dictation-cancel" }, { type: "stop-speech" }, { type: "hide" }, { type: "show" },
      { type: "mute", muted: true }, { type: "mute", muted: false }, { type: "dictation-disable" }, { type: "voice-help" },
    ]);
    expect(client.tui.appendPrompt).not.toHaveBeenCalled(); expect(client.tui.submitPrompt).not.toHaveBeenCalled();
  });
  it("executes clear, stop-task and new-task with project-scoped TUI events", async () => {
    const { client } = await setup("/voice-project");
    for (const command of ["clear", "stop-task", "new-task"]) mocks.receive?.({ type: "voice-command", command });
    await vi.waitFor(() => expect(client.tui.executeCommand).toHaveBeenCalledTimes(2));
    expect(client.tui.clearPrompt).toHaveBeenCalledWith({ query: { directory: "/voice-project" }, signal: expect.any(AbortSignal) });
    for (const command of ["session.interrupt", "session.new"]) expect(client.tui.executeCommand).toHaveBeenCalledWith({ query: { directory: "/voice-project" }, body: { command }, signal: expect.any(AbortSignal) });
    expect(client.tui.submitPrompt).not.toHaveBeenCalled();
  });
  it("stops native speech even while an append request has not completed", async () => {
    const { client } = await setup();
    let release!: (value: object) => void;
    client.tui.appendPrompt.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    mocks.receive?.({ type: "transcript", text: "Незаконченная отправка" });
    await vi.waitFor(() => expect(client.tui.appendPrompt).toHaveBeenCalledOnce());
    try {
      mocks.receive?.({ type: "voice-command", command: "stop-speech" });
      expect(mocks.send).toHaveBeenCalledWith({ type: "stop-speech" });
      expect(client.tui.submitPrompt).not.toHaveBeenCalled();
    } finally { release({}); }
  });
  it("restores failed dictation without submitting and allows a later explicit send", async () => {
    const { client, hooks } = await setup();
    client.tui.appendPrompt.mockRejectedValueOnce(new Error("offline"));
    mocks.receive?.({ type: "voice-command", command: "submit", text: "Повторить после восстановления" });
    await vi.waitFor(() => expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ message: "Error: offline" }) })));
    await action(hooks, "recover_dictation");
    expect(client.tui.submitPrompt).not.toHaveBeenCalled();
    mocks.receive?.({ type: "voice-command", command: "submit" });
    await vi.waitFor(() => expect(client.tui.submitPrompt).toHaveBeenCalledOnce());
  });
  it("keeps ordinary transcripts as text even when they contain words or unrelated fields naming commands", async () => {
    const { client } = await setup();
    mocks.receive?.({ type: "transcript", text: "добавь слово отправить", command: "submit" });
    await vi.waitFor(() => expect(client.tui.appendPrompt).toHaveBeenCalledOnce());
    expect(client.tui.appendPrompt).toHaveBeenCalledWith(expect.objectContaining({ body: { text: "добавь слово отправить " } }));
    expect(client.tui.submitPrompt).not.toHaveBeenCalled();
  });
  it("native stop feedback clears the router queue without waiting for stale playback completion", async () => {
    const { hooks } = await setup(); await task(hooks);
    mocks.send.mockImplementation(event => {
      if (event.type === "stop-speech") mocks.receive?.({ type: "speech-control", action: "stop" });
    });
    mocks.receive?.({ type: "voice-command", command: "stop-speech" });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: "stop", characterId: "s" }));
    const count = mocks.send.mock.calls.filter(([event]) => event.type === "speak").length;
    mocks.receive?.({ type: "audio-finished", id: "stale-audio", phase: "end" });
    expect(mocks.send.mock.calls.filter(([event]) => event.type === "speak")).toHaveLength(count);
  });
});
