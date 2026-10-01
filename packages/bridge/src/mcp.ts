#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCodex } from "./run.js";

const server = new McpServer({ name: "codexbridge", version: "0.2.0" });
const active = new Set<AbortController>();
server.registerTool("codex", {
  description: "Run local Codex in the configured project. System access requires a human elicitation channel; otherwise it is denied.",
  inputSchema: { prompt: z.string().min(1), threadId: z.string().optional(), model: z.string().optional() },
}, async (args, extra) => {
  const controller = new AbortController();
  active.add(controller);
  try {
    const result = await runCodex({ ...args,
      cwd: process.env.CODEXBRIDGE_PROJECT ?? process.cwd(),
      signal: AbortSignal.any([extra.signal, controller.signal]),
      async approve(request) {
        if (!server.server.getClientCapabilities()?.elicitation?.form) return false;
        const response = await server.server.elicitInput({
          mode: "form", message: `Codex requests OS access: ${JSON.stringify(request)}`,
          requestedSchema: { type: "object", properties: { allow: { type: "boolean", title: "Allow this request once?" } }, required: ["allow"] },
        });
        return response.action === "accept" && response.content?.allow === true;
      },
    });
    return { isError: result.status !== "completed", content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  } finally { active.delete(controller); }
});
const stop = async (): Promise<void> => {
  for (const controller of active) controller.abort();
  await server.close();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
process.stdin.once("end", () => void stop());
await server.connect(new StdioServerTransport());
