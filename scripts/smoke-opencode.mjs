import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

const root = fileURLToPath(new URL("../", import.meta.url));
const native = process.argv.includes("--native");
const inference = process.argv.includes("--inference");
if (native && process.platform !== "darwin") throw new Error("Native voice smoke requires macOS");
const temp = await mkdtemp(join(tmpdir(), "codexbridge-opencode-smoke-"));
const config = JSON.parse(await readFile(join(root, ".local/profiles/quiet/opencode.json"), "utf8"));
for (const server of Object.values(config.mcp)) server.enabled = false;
await writeFile(join(temp, "opencode.json"), JSON.stringify(config));
await writeFile(join(temp, "smart-voice-notify.jsonc"), '{"enabled":false}');
await writeFile(join(temp, "companions.json"), JSON.stringify({ enabled: native, showOnStart: false, speech: "off", dictation: false }));
const expected = `CODEXBRIDGE_${randomUUID()}`;
if (inference) await writeFile(join(temp, "fixture.txt"), expected);
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
  assert(ids.includes("submit_plan"), "Planner plugin was not loaded");
  if (native) assert(ids.includes("companion"), `Native voice plugin was not loaded: ${logs}`);
  assert.equal(configured.permission.codex_system, "ask");
  assert(configured.lsp.typescript.command.includes("--stdio"));
  const agentResponse = await fetch(`${url}/agent`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(agentResponse.status, 200, "Cannot list OpenCode agents");
  const agents = await agentResponse.json();
  for (const name of ["designer", "devops", "tester"]) {
    const agent = agents.find(item => item.name === name);
    assert.equal(agent?.mode, "subagent", `Missing subagent: ${name}; regenerate the profile`);
    assert.equal(agent.model, undefined, `${name} must inherit its caller's model`);
    for (const permission of ["codex", "codex_system"]) {
      assert.equal(agent.permission.filter(rule => rule.permission === permission && rule.pattern === "*").at(-1)?.action,
        "ask", `${name} changed the bridge approval policy: ${permission}`);
    }
  }
  console.log("PASS: real OpenCode loaded CLI plugins; codex tool, OS approval rule and TypeScript LSP configured");
  console.log("PASS: designer, devops and tester inherit the caller's model and bridge approval rules");
  console.log(JSON.stringify({ customTools: ids.filter(id => ["codex", "submit_plan", "companion"].includes(id)), version: "1.3.2", native }));
  if (inference) {
    assert(config.model?.startsWith("codexbridge/"), "Configure the bridge provider first: npm run connect:codex && npm run bundle:all");
    // Only a public marker enters the isolated OpenCode store. Codex retains its own credentials.
    const auth = await fetch(`${url}/auth/codexbridge`, { method: "PUT",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "api", key: "codexbridge-managed" }) });
    assert.equal(auth.status, 200, "Cannot enable CodexBridge auth hook");
    const created = await fetch(`${url}/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(created.status, 200, "Cannot create a smoke session");
    const session = await created.json();
    const modelID = config.model.slice("codexbridge/".length);
    const response = await fetch(`${url}/session/${session.id}/message`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(150_000),
      body: JSON.stringify({ model: { providerID: "codexbridge", modelID }, agent: "build",
        parts: [{ type: "text", text: "Integration test: read fixture.txt using the read tool, then reply with exactly its contents. Do not inspect other paths, modify files, or call any other tools." }] }),
    });
    assert.equal(response.status, 200, "OpenCode inference request failed");
    const responseText = await response.text();
    const history = await fetch(`${url}/session/${session.id}/message`).then(r => r.json());
    const modelError = history.findLast(message => message.info?.error)?.info.error;
    assert(responseText.trim(), modelError?.data?.message ?? "OpenCode returned an empty model response");
    const result = JSON.parse(responseText);
    assert(!result.info?.error, result.info?.error?.data?.message ?? "Model returned an error");
    const parts = history.flatMap(message => message.parts ?? []);
    assert(parts.some(part => part.type === "tool" && part.tool === "read" && part.state?.status === "completed" && part.state.output.includes(expected)),
      "The model did not complete the real read tool call");
    assert.equal(result.parts.filter(part => part.type === "text").map(part => part.text).join("").trim(), expected);
    console.log(`PASS: OpenCode → CodexBridge auth → ${modelID}; real read tool call and exact final response`);
  }
} finally {
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), 1500);
  await exit; clearTimeout(kill);
}
