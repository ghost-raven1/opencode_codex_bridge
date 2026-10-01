import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInput, ToolContext } from "@opencode-ai/plugin";
import type { CodexSpeech, RunOptions } from "../packages/bridge/src/types.js";

vi.mock("../packages/bridge/src/run.js", () => ({ runCodex: vi.fn() }));
vi.mock("../packages/bridge/src/auth.js", () => ({ createCodexAuthHook: vi.fn(() => ({})) }));
import CodexBridge from "../packages/bridge/src/plugin.js";
import { runCodex } from "../packages/bridge/src/run.js";
beforeEach(() => vi.clearAllMocks());

describe("bridge speech metadata", () => {
  it("keeps completed messages in every later preview and the final tool result", async () => {
    const speech: CodexSpeech = { runId: "run", threadId: "thread", state: "running",
      messages: [{ messageId: "message", text: "Public message", state: "completed" }] };
    vi.mocked(runCodex).mockImplementation(async (options: RunOptions) => {
      options.onSpeech?.(speech); options.onText?.("Unfinished UI preview");
      return { threadId: "thread", turnId: "turn", status: "completed", text: "Public message",
        codexSpeech: { ...speech, state: "completed" } };
    });
    const metadata = vi.fn(), ask = vi.fn(async () => {});
    const hooks = await CodexBridge({} as PluginInput);
    const result = await hooks.tool!.codex!.execute({ prompt: "Task" }, {
      sessionID: "session", callID: "call", directory: "/project", abort: new AbortController().signal, metadata, ask,
    } as unknown as ToolContext);
    expect(metadata.mock.calls.at(-2)?.[0]).toMatchObject({
      metadata: { output: "Unfinished UI preview", codexSpeech: speech },
    });
    expect(JSON.parse(result as string)).toMatchObject({ text: "Public message", threadId: "thread" });
    const output = { title: "", output: "truncated tool output", metadata: { truncated: true } };
    await hooks["tool.execute.after"]!({ tool: "codex", sessionID: "session", callID: "call", args: { prompt: "Task" } }, output);
    expect(output).toMatchObject({ metadata: { truncated: true, threadId: "thread", codexSpeech: { ...speech, state: "completed" } } });
    const duplicate = { title: "", output: "same", metadata: {} };
    await hooks["tool.execute.after"]!({ tool: "codex", sessionID: "session", callID: "call", args: {} }, duplicate);
    expect(duplicate.metadata).toEqual({});
  });
});
