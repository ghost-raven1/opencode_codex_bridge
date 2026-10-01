import { join } from "node:path";

export const playwrightVersion = "0.0.83";

/** Keep the same optional MCP integrations in every OpenCode profile. */
export function mcpConfiguration(root, node = process.execPath) {
  return {
    jarvis: { type: "local", command: [node, join(root, "node_modules/@shantur/jarvis-mcp/dist/index.js")],
      enabled: false, environment: { MCP_VOICE_AUTO_OPEN: "false" }, timeout: 120_000 },
    openai_docs: { type: "remote", url: "https://developers.openai.com/mcp", enabled: true, oauth: false, timeout: 20_000 },
    context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true, oauth: false, timeout: 20_000 },
    grep: { type: "remote", url: "https://mcp.grep.app", enabled: true, oauth: false, timeout: 20_000 },
    playwright: { type: "local", command: [node, join(root, "scripts/playwright-mcp.mjs")], enabled: true, timeout: 30_000 },
  };
}

/** The browser install belongs to the distribution; artifacts belong to the current project. */
export function playwrightDirectories(root, project) {
  return { browsers: join(root, ".local/playwright/browsers"), artifacts: join(project, ".local/mcp-artifacts/playwright") };
}
