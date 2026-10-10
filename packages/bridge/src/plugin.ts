import { tool, type Plugin } from "@opencode-ai/plugin";
import { runCodex } from "./run.js";
import { createCodexAuthHook } from "./auth.js";
import type { RunResult } from "./types.js";

/** OpenCode owns the terminal and human approvals; Codex runs over private stdio. */
const CodexBridge: Plugin = async () => {
  const completed = new Map<string, Pick<RunResult, "threadId" | "status">>();
  return {
    auth: createCodexAuthHook(),
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "codex") return;
      const key = JSON.stringify([input.sessionID, input.callID]), result = completed.get(key);
      if (!result) return;
      completed.delete(key);
      output.title = `Codex · ${result.status}`;
      output.metadata = { ...output.metadata, threadId: result.threadId };
    },
    tool: {
      codex: tool({
        description: "Delegate a coding task to local Codex. Runs in this project; returns threadId for follow-ups. OS access requests use OpenCode permissions. Never retry an interrupted mutation without inspecting its effects.",
        args: {
          prompt: tool.schema.string().min(1).describe("Task for Codex"),
          threadId: tool.schema.string().optional().describe("Previous Codex thread from this project"),
          model: tool.schema.string().optional().describe("Omit to retain the user's configured Codex model"),
        },
        async execute(args, context) {
          await context.ask({ permission: "codex", patterns: [context.directory], always: [context.directory],
            metadata: { prompt: args.prompt, directory: context.directory } });
          context.metadata({ title: "Codex · задача в работе" });
          let preview = "";
          const result = await runCodex({
            ...args, cwd: context.directory, signal: context.abort,
            onText(text) {
              preview = (preview + text).slice(-2000);
              context.metadata({ title: "Codex · задача в работе", metadata: { output: preview } });
            },
            async approve(request) {
              // Unique request scope prevents a previous blanket tool approval granting OS access.
              await context.ask({ permission: "codex_system",
                patterns: [JSON.stringify({ method: request.method, ...request.details })], always: [],
                metadata: { method: request.method, ...request.details } });
              return true;
            },
          });
          context.metadata({ title: `Codex · ${result.status}`, metadata: { output: preview, threadId: result.threadId } });
          // Runtime 1.3.2 supplies callID, although its public plugin ToolContext omits the field.
          const callID = (context as typeof context & { callID?: string }).callID;
          if (callID) {
            completed.set(JSON.stringify([context.sessionID, callID]), { threadId: result.threadId, status: result.status });
            if (completed.size > 128) completed.delete(completed.keys().next().value!);
          }
          return JSON.stringify(result);
        },
      }),
    },
  };
};
export default CodexBridge;
