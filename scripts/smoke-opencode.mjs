import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(root, ".local/opencode-smoke-"));
const config = JSON.parse(await readFile(join(root, ".local/profiles/quiet/opencode.json"), "utf8"));
for (const server of Object.values(config.mcp)) server.enabled = false;
await writeFile(join(temp, "opencode.json"), JSON.stringify(config));
await writeFile(join(temp, "smart-voice-notify.jsonc"), '{"enabled":false}');
await writeFile(join(temp, "companions.json"), '{"enabled":false}');
const child = spawn("opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
  cwd: temp, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, XDG_CONFIG_HOME: join(temp, "config"), XDG_DATA_HOME: join(temp, "data"),
    XDG_CACHE_HOME: join(temp, "cache"), XDG_STATE_HOME: join(temp, "state"),
    OPENCODE_CONFIG: join(temp, "opencode.json"), OPENCODE_CONFIG_DIR: temp,
    OPENCODE_DISABLE_MODELS_FETCH: "true", PATH: `${root}.local/bin:${process.env.PATH}` },
});
let logs = "";
child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-5000); });
const exit = new Promise(resolve => child.once("exit", resolve));
try {
  const url = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`OpenCode startup timeout: ${logs}`)), 40_000);
    let stdout = "";
    child.stdout.on("data", chunk => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(deadline); resolve(match[0]); }
    });
    child.once("error", error => { clearTimeout(deadline); reject(error); });
    child.once("exit", code => { clearTimeout(deadline); reject(new Error(`OpenCode exited ${code}: ${logs}`)); });
  });
  const result = await fetch(`${url}/experimental/tool/ids`, { signal: AbortSignal.timeout(60_000) });
  const text = await result.text();
  assert.equal(result.status, 200, text);
  const ids = JSON.parse(text);
  const configured = await fetch(`${url}/config`).then(r => r.json());
  assert(ids.includes("codex"), `Codex plugin was not loaded: ${JSON.stringify({ ids, plugins: configured.plugin })}. ${logs}`);
  assert.equal(configured.permission.codex_system, "ask");
  assert(configured.lsp.typescript.command.includes("--stdio"));
  console.log("PASS: real OpenCode loaded CLI plugins; codex tool, OS approval rule and TypeScript LSP configured");
  console.log(JSON.stringify({ customTools: ids.filter(id => ["codex", "submit_plan"].includes(id)), version: "1.3.2" }));
} finally {
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), 1500);
  await exit; clearTimeout(kill);
}
