import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import { configSchema } from "../packages/companions/src/config.js";

const mocks = vi.hoisted(() => ({
  receive: undefined as undefined | ((event: Record<string, unknown> & { type: string }) => void),
  send: vi.fn(), close: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ access: vi.fn(async () => {}) }));
vi.mock("../packages/companions/src/atlas.js", () => ({ validateAtlas: vi.fn(async () => { throw new Error("Missing atlas"); }) }));
vi.mock("../packages/companions/src/config.js", async importOriginal => ({
  ...await importOriginal<object>(), readConfig: vi.fn(),
}));
vi.mock("../packages/companions/src/native-host.js", () => ({
  startNativeHost: vi.fn(async (_binary, _args, receive) => {
    mocks.receive = receive; return { send: mocks.send, close: mocks.close };
  }),
}));
import Companions from "../packages/companions/src/plugin.js";
import { readConfig } from "../packages/companions/src/config.js";
import { startNativeHost } from "../packages/companions/src/native-host.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
Object.defineProperty(process, "platform", { value: "darwin" });
afterAll(() => Object.defineProperty(process, "platform", platform));
beforeEach(() => {
  vi.clearAllMocks(); mocks.receive = undefined;
  vi.mocked(readConfig).mockResolvedValue(configSchema.parse({ enabled: true }));
});
function input() {
  const client = { app: { log: vi.fn(async () => ({})) }, tui: {
    appendPrompt: vi.fn(async () => ({})), submitPrompt: vi.fn(), showToast: vi.fn(async () => ({})),
  } };
  return { client, context: { directory: "/project", client } as unknown as PluginInput };
}

describe("CLI system voice integration", () => {
  it("starts system voice and exposes controls even without valid artwork", async () => {
    const t = input(); const hooks = await Companions(t.context);
    expect(hooks.tool?.companion).toBeDefined();
    expect(vi.mocked(startNativeHost).mock.calls[0]?.[1]).not.toContain("--atlas");
    await hooks.event?.({ event: { type: "message.updated", properties: { info: {
      id: "u", sessionID: "s", role: "user", agent: "build",
    } } } as never });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: "speak", text: "Задача в работе." }));
  });
  it("inserts dictated text as a draft exactly once and never submits it", async () => {
    const t = input(); await Companions(t.context);
    mocks.receive?.({ type: "transcript", text: "Проверь тесты" });
    await vi.waitFor(() => expect(t.client.tui.appendPrompt).toHaveBeenCalledTimes(1));
    expect(t.client.tui.appendPrompt).toHaveBeenCalledWith({ query: { directory: "/project" }, body: { text: "Проверь тесты " } });
    expect(t.client.tui.submitPrompt).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "dictation-start" }));
  });
  it("retains undelivered dictation for explicit recovery and cleans up on dispose", async () => {
    const t = input();
    t.client.tui.appendPrompt.mockRejectedValueOnce(new Error("offline"));
    const hooks = await Companions(t.context);
    mocks.receive?.({ type: "transcript", text: "Сохрани этот черновик" });
    await vi.waitFor(() => expect(t.client.app.log).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ message: "Error: offline" }) })));
    await hooks.tool!.companion!.execute({ action: "recover_dictation" }, {} as never);
    expect(t.client.tui.appendPrompt).toHaveBeenCalledTimes(2);
    await hooks.dispose?.(); expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("serializes concurrent recovery and incoming dictation without duplicates", async () => {
    const t = input(); t.client.tui.appendPrompt.mockRejectedValueOnce(new Error("offline"));
    const hooks = await Companions(t.context);
    mocks.receive?.({ type: "transcript", text: "Первый" });
    await vi.waitFor(() => expect(t.client.tui.appendPrompt).toHaveBeenCalledTimes(1));
    let release: (value: object) => void;
    t.client.tui.appendPrompt.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const a = hooks.tool!.companion!.execute({ action: "recover_dictation" }, {} as never);
    const b = hooks.tool!.companion!.execute({ action: "recover_dictation" }, {} as never);
    await vi.waitFor(() => expect(t.client.tui.appendPrompt).toHaveBeenCalledTimes(2));
    mocks.receive?.({ type: "transcript", text: "Второй" });
    release!({}); await Promise.all([a, b]);
    expect(t.client.tui.appendPrompt.mock.calls.map(([call]) => (call as any)?.body.text)).toEqual(["Первый ", "Первый ", "Второй "]);
  });
  it("reports overflow explicitly and keeps already accepted drafts intact", async () => {
    const t = input(); t.client.tui.appendPrompt.mockRejectedValue(new Error("offline"));
    const hooks = await Companions(t.context);
    for (let i = 0; i < 17; i++) mocks.receive?.({ type: "transcript", text: `Черновик ${i}` });
    await vi.waitFor(() => expect(t.client.tui.appendPrompt).toHaveBeenCalledTimes(16));
    expect(t.client.app.log).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ message: expect.stringContaining("Новая запись не принята") }) }));
    t.client.tui.appendPrompt.mockResolvedValue({});
    await hooks.tool!.companion!.execute({ action: "recover_dictation" }, {} as never);
    expect(t.client.tui.appendPrompt.mock.calls.slice(16).map(([call]) => (call as any)?.body.text)).toEqual(Array.from({ length: 16 }, (_, i) => `Черновик ${i} `));
  });
  it("routes the user task to role detection before the first message event", async () => {
    const t = input(); const hooks = await Companions(t.context);
    await hooks["chat.message"]?.({ sessionID: "s", agent: "build" }, {
      message: { id: "u", agent: "build" } as never,
      parts: [{ type: "text", text: "Проверь изменения и найди ошибки" }] as never,
    });
    await hooks.event?.({ event: { type: "message.updated", properties: { info: {
      id: "u", sessionID: "s", role: "user", agent: "build",
    } } } as never });
    expect(mocks.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "speak", role: "reviewer" }));
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: "state", role: "reviewer" }));
  });
  it("assigns the actual child session from task metadata", async () => {
    const hooks = await Companions(input().context);
    await hooks["tool.execute.after"]?.({ tool: "task", sessionID: "parent", callID: "call",
      args: { subagent_type: "general", description: "Research API docs", prompt: "Find official references" },
    }, { title: "Research", output: "done", metadata: { sessionId: "child" } });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: "state", characterId: "child", role: "researcher" }));
  });
  it("quiet profile never starts a native process", async () => {
    vi.mocked(readConfig).mockResolvedValue(configSchema.parse({ enabled: false }));
    expect(await Companions(input().context)).toEqual({});
    expect(startNativeHost).not.toHaveBeenCalled();
  });
});
