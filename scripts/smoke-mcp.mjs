import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const [name, script, expected] of [
  ["bridge", "packages/bridge/dist/mcp.js", "codex"],
  ["jarvis", "node_modules/@shantur/jarvis-mcp/dist/index.js", "get_voice_input"],
]) {
  const client = new Client({ name: "codexbridge-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [root + script], stderr: "pipe" });
  transport.stderr?.resume();
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert(tools.tools.some(t => t.name === expected), `${name}: missing ${expected}`);
    console.log(`PASS ${name}: MCP initialize + tools/list (${tools.tools.map(t => t.name).join(", ")})`);
  } finally { await client.close(); }
}
