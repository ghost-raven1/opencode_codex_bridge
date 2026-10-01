import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

/** Bound each optional server independently so one outage cannot hide the other results. */
export async function probeMcpServer({ name, config, expectedTool, optional = true, verify, timeout = 20_000 }) {
  const client = new Client({ name: "codexbridge-smoke", version });
  const transport = config.type === "remote"
    ? new StreamableHTTPClientTransport(new URL(config.url))
    : new StdioClientTransport({ command: config.command[0], args: config.command.slice(1),
      env: config.environment, stderr: "pipe" });
  if (transport instanceof StdioClientTransport) transport.stderr?.resume();
  let stage = "initialize";
  try {
    await client.connect(transport, { timeout });
    stage = "tools/list";
    const { tools } = await client.listTools(undefined, { timeout });
    if (!tools.some(tool => tool.name === expectedTool)) throw new Error(`Missing tool ${expectedTool}`);
    stage = "tools/call";
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
      if (result.isError) throw new Error(`${name} returned an error: ${textContent(result).slice(0, 400)}`);
      return result;
    };
    const detail = verify ? await verify(call, tools) : "handshake only (no recording or model invocation)";
    return { name, status: "pass", tools: tools.length, detail };
  } catch (error) {
    return { name, status: optional ? "unavailable" : "fail", stage,
      detail: String(error?.message ?? error).replace(/[\r\n]+/g, " ").slice(0, 500) };
  } finally { await client.close().catch(() => undefined); }
}

export function textContent(result) {
  return result.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
}

/** Default mode tolerates optional outages; strict mode is useful for release verification. */
export function mcpExitCode(results, strict = false) {
  return results.some(result => result.status === "fail" || (strict && result.status !== "pass")) ? 1 : 0;
}
