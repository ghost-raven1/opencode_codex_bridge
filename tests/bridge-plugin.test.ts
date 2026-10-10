import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInput, ToolContext } from "@opencode-ai/plugin";
import type { RunOptions } from "../packages/bridge/src/types.js";

vi.mock("../packages/bridge/src/run.js", () => ({ runCodex: vi.fn() }));
vi.mock("../packages/bridge/src/auth.js", () => ({ createCodexAuthHook: vi.fn(() => ({})) }));
import CodexBridge from "../packages/bridge/src/plugin.js";
import { runCodex } from "../packages/bridge/src/run.js";
beforeEach(() => vi.clearAllMocks());

describe("bridge tool metadata", () => {
  it("keeps streaming previews and the thread id through tool output truncation", async () => {
    vi.mocked(runCodex).mockImplementation(async (options: RunOptions) => {
      options.onText?.("Unfinished UI preview");
      return { threadId: "thread", turnId: "turn", status: "completed", text: "Public message" };
    });
    const metadata = vi.fn(), ask = vi.fn(async () => {});
    const hooks = await CodexBridge({} as PluginInput);
    const result = await hooks.tool!.codex!.execute({ prompt: "Task" }, {
      sessionID: "session", callID: "call", directory: "/project", abort: new AbortController().signal, metadata, ask,
    } as unknown as ToolContext);
    expect(metadata.mock.calls.at(-2)?.[0]).toMatchObject({
      metadata: { output: "Unfinished UI preview" },
    });
    expect(JSON.parse(result as string)).toEqual({ text: "Public message", threadId: "thread", turnId: "turn", status: "completed" });
    expect(metadata.mock.calls.at(-1)?.[0]).toEqual({ title: "Codex · completed",
      metadata: { output: "Unfinished UI preview", threadId: "thread" } });
    const output = { title: "", output: "truncated tool output", metadata: { truncated: true } };
    await hooks["tool.execute.after"]!({ tool: "codex", sessionID: "session", callID: "call", args: { prompt: "Task" } }, output);
    expect(output).toEqual({ title: "Codex · completed", output: "truncated tool output", metadata: { truncated: true, threadId: "thread" } });
    const duplicate = { title: "", output: "same", metadata: {} };
    await hooks["tool.execute.after"]!({ tool: "codex", sessionID: "session", callID: "call", args: {} }, duplicate);
    expect(duplicate.metadata).toEqual({});
  });
});
