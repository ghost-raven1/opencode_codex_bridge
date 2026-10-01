import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRequire } from "node:module";
import { mcpConfiguration, playwrightDirectories, playwrightVersion } from "./lib/mcp-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
let problems = 0;
function check(name, ok, detail) { console.log(`${ok ? "OK" : "MISSING"} ${name}: ${detail}`); if (!ok) problems++; }
check("Node", Number(process.versions.node.split(".")[0]) === 24 && Number(process.versions.node.split(".")[1]) >= 15, process.versions.node + " (requires 24.15+)");
for (const command of ["codex", "opencode", "snip"]) {
  const local = command === "snip" ? join(root, ".local/bin/snip") : command === "codex" ? join(root, "node_modules/.bin/codex") : command;
  const result = spawnSync(local, ["--version"], { encoding: "utf8", timeout: 15_000 });
  const fallback = result.error && command === "snip" ? spawnSync(command, ["--version"], { encoding: "utf8", timeout: 15_000 }) : result;
  const version = (fallback.stdout ?? "").trim();
  check(command, fallback.status === 0 && (command !== "opencode" || version === "1.3.2"),
    version || fallback.error?.message || "not available");
}
for (const path of ["packages/bridge/dist/plugin.js", "packages/companions/dist/plugin.js", "packages/companions/assets/team-atlas.png", "packages/companions/native/Companions"]) {
  try { await access(join(root, path), constants.R_OK); check(path, true, "present"); }
  catch { check(path, false, "run build / companion:build"); }
}
try {
  const catalog = JSON.parse(await readFile(join(root, ".local/codex-provider.json"), "utf8"));
  check("Codex model catalog", catalog.models?.some(model => model.id === catalog.defaultModel),
    `${catalog.models?.length ?? 0} models; default ${catalog.defaultModel} (run smoke:provider to verify inference)`);
} catch { check("Codex model catalog", false, "run npm run connect:codex and npm run bundle:all"); }
try {
  const { validateAtlas } = await import("../packages/companions/dist/atlas.js");
  await validateAtlas(join(root, "packages/companions/assets/team-atlas.png"));
  console.log("OK companion atlas: transparent PNG with a uniform grid");
} catch (error) { console.warn(`WARN optional companion artwork: ${error.message}`); }
try {
  const require = createRequire(import.meta.url);
  const installed = require("@playwright/mcp/package.json");
  check("Playwright MCP", installed.version === playwrightVersion, `${installed.version} (requires ${playwrightVersion})`);
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightDirectories(root, root).browsers;
  const browser = createRequire(require.resolve("@playwright/mcp/package.json"))("playwright-core").chromium.executablePath();
  await access(browser, constants.X_OK);
  check("Project Chromium", true, browser);
} catch (error) { check("Project Chromium", false, `${error.message}; run npm run setup:playwright`); }
const expectedMcp = mcpConfiguration(root);
for (const profile of ["companions", "jarvis", "quiet"]) {
  try {
    const config = JSON.parse(await readFile(join(root, ".local/profiles", profile, "opencode.json"), "utf8"));
    const sameServers = Object.entries(expectedMcp).every(([name, expected]) => {
      const actual = config.mcp?.[name];
      return actual?.type === expected.type && actual.enabled === expected.enabled &&
        (expected.type === "remote" ? actual.url === expected.url : JSON.stringify(actual.command) === JSON.stringify(expected.command));
    });
    check(`${profile} MCP`, sameServers, "Jarvis retained; OpenAI Docs, Context7, Grep and isolated Playwright configured");
    const companions = JSON.parse(await readFile(join(root, ".local/profiles", profile, "companions.json"), "utf8"));
    check(`${profile} startup`, companions.showOnStart === false, "character preview requires an explicit command");
  } catch { check(`${profile} MCP`, false, "run npm run bundle:all"); }
}
if (process.argv.includes("--mcp")) {
  const probe = spawnSync(process.execPath, [join(root, "scripts/smoke-mcp.mjs"),
    ...(process.argv.includes("--strict") ? ["--strict"] : [])], { stdio: "inherit", timeout: 120_000 });
  check("MCP probes", probe.status === 0, probe.error?.message ?? "connection, tools/list and useful tool calls");
} else console.log("INFO run npm run doctor -- --mcp for live MCP checks; add --strict for release verification.");
process.exitCode = problems ? 1 : 0;
