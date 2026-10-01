import { describe, expect, it } from "vitest";
import { mcpConfiguration, playwrightDirectories } from "../scripts/lib/mcp-config.mjs";
import { mcpExitCode, probeMcpServer } from "../scripts/lib/mcp-probe.mjs";

describe("distribution MCP integration", () => {
  it("retains voice/docs integrations and resolves the browser launcher in a workspace containing spaces", () => {
    const config = mcpConfiguration("/project with spaces", "/runtime/node");
    expect(config.jarvis.enabled).toBe(false);
    expect(config.jarvis.environment.MCP_VOICE_AUTO_OPEN).toBe("false");
    expect(config.openai_docs.url).toBe("https://developers.openai.com/mcp");
    expect(config.context7).toMatchObject({ type: "remote", url: "https://mcp.context7.com/mcp", oauth: false });
    expect(config.grep).toMatchObject({ type: "remote", url: "https://mcp.grep.app", oauth: false });
    expect(config.playwright.command).toEqual(["/runtime/node", "/project with spaces/scripts/playwright-mcp.mjs"]);
    expect(playwrightDirectories("/distribution", "/current project")).toEqual({
      browsers: "/distribution/.local/playwright/browsers", artifacts: "/current project/.local/mcp-artifacts/playwright",
    });
  });

  it("reports a missing optional server without failing normal diagnostics, while strict mode fails", async () => {
    const result = await probeMcpServer({ name: "missing-optional", expectedTool: "anything",
      config: { type: "local", command: ["/no-such-codexbridge-mcp-executable"] }, timeout: 1000 });
    expect(result).toMatchObject({ name: "missing-optional", status: "unavailable", stage: "initialize" });
    expect(mcpExitCode([{ status: "pass" }, result])).toBe(0);
    expect(mcpExitCode([{ status: "pass" }, result], true)).toBe(1);
  });

  it("still fails diagnostics when the required bridge is unavailable", async () => {
    const result = await probeMcpServer({ name: "bridge", expectedTool: "codex", optional: false,
      config: { type: "local", command: [process.execPath, "-e", "process.exit(1)"] }, timeout: 1000 });
    expect(result).toMatchObject({ name: "bridge", status: "fail", stage: "initialize" });
    expect(mcpExitCode([result])).toBe(1);
  });

  it("times out and closes an optional server that never completes initialization", async () => {
    const start = Date.now();
    const result = await probeMcpServer({ name: "hung-optional", expectedTool: "anything",
      config: { type: "local", command: [process.execPath, "-e", "setInterval(() => {}, 1000)"] }, timeout: 100 });
    expect(result).toMatchObject({ status: "unavailable", stage: "initialize" });
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
