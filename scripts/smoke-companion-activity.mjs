import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Real OpenCode events, an isolated local provider and a tool longer than the departure timeout.
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "codexbridge-activity-"));
const trace = join(temporary, "events.jsonl");
const moduleURL = path => pathToFileURL(join(root, path)).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const stub = createServer(async (request, response) => {
  let raw = ""; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const done = body.messages?.some(message => message.role === "tool");
  const chunk = delta => ({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta, finish_reason: null }] });
  const content = chunk(done ? { role: "assistant", content: "DONE" } : {
    role: "assistant", tool_calls: [{ index: 0, id: "long-tool", type: "function",
      function: { name: "hold_companion", arguments: "{}" } }],
  });
  const end = chunk({}); end.choices[0].finish_reason = done ? "stop" : "tool_calls";
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(`data: ${JSON.stringify(content)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
});
let child, exited, logs = "";
try {
  await new Promise(resolve => stub.listen(0, "127.0.0.1", resolve));
  const plugin = `import { appendFileSync } from "node:fs";
import { tool } from ${JSON.stringify(import.meta.resolve("@opencode-ai/plugin"))};
import { CompanionDirector } from ${JSON.stringify(moduleURL("packages/companions/dist/director.js"))};
import { CompanionLifecycle } from ${JSON.stringify(moduleURL("packages/companions/dist/lifecycle.js"))};
import { configSchema } from ${JSON.stringify(moduleURL("packages/companions/dist/config.js"))};
export default async () => {
  const record = event => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ ...event, at: Date.now() }) + "\\n");
  const config = configSchema.parse({ speech: "off" });
  const lifecycle = new CompanionLifecycle(config, record);
  const director = new CompanionDirector(config, event => lifecycle.event(event));
  let injected = false;
  return {
    dispose: async () => lifecycle.dispose(),
    event: async ({ event }) => {
      director.event(event);
      const part = event.properties?.part;
      if (!injected && part?.type === "tool" && part.tool === "hold_companion" && part.state.status === "running") {
        injected = true; record({ type: "injected-idle" });
        director.event({ type: "session.idle", properties: { sessionID: part.sessionID } });
      }
    },
    "chat.message": async (input, output) => director.assignTask(input.sessionID,
      { task: "Проверь длительную работу", messageID: output.message.id }),
    tool: { hold_companion: tool({ description: "Local lifecycle test", args: {}, execute: async () => {
      record({ type: "tool-start" }); await new Promise(resolve => setTimeout(resolve, 12500));
      record({ type: "tool-end" }); return "DONE";
    } }) },
  };
};`;
  await writeFile(join(temporary, "plugin.mjs"), plugin);
  const config = {
    model: "fixture/fixture", small_model: "fixture/fixture", plugin: [pathToFileURL(join(temporary, "plugin.mjs")).href],
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${stub.address().port}/v1` },
      models: { fixture: { name: "Fixture", tool_call: true, limit: { context: 32000, output: 1000 } } } } },
    permission: { "*": "deny", hold_companion: "allow" }, agent: { title: { disable: true }, summary: { disable: true } },
  };
  await writeFile(join(temporary, "opencode.json"), JSON.stringify(config));
  child = spawn("opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: temporary, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      PATH: `${join(root, ".local/bin")}:${process.env.PATH}`, OPENCODE_CONFIG_DIR: temporary,
      OPENCODE_CONFIG: join(temporary, "opencode.json"), OPENCODE_DISABLE_MODELS_FETCH: "true",
      XDG_CONFIG_HOME: join(temporary, "config"), XDG_DATA_HOME: join(temporary, "data"),
      XDG_STATE_HOME: join(temporary, "state"), XDG_CACHE_HOME: join(temporary, "cache"),
    },
  });
  exited = new Promise(resolve => child.once("exit", resolve));
  child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-4000); });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 30000);
    let out = "";
    child.stdout.on("data", chunk => {
      out += chunk; const match = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`OpenCode exited ${code}: ${logs}`)); });
  });
  const request = async (path, body) => {
    const result = await fetch(endpoint + path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const text = await result.text(); assert.equal(result.status, 200, text); return JSON.parse(text);
  };
  const session = await request("/session", {});
  const reply = await request(`/session/${session.id}/message`, { model: { providerID: "fixture", modelID: "fixture" },
    agent: "build", parts: [{ type: "text", text: "Run hold_companion once, then reply DONE." }] });
  assert(!reply.info?.error, JSON.stringify(reply.info?.error));
  const events = async () => (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const deadline = Date.now() + 12500;
  let rows = await events();
  while (!rows.some(event => event.type === "remove") && Date.now() < deadline) { await delay(100); rows = await events(); }
  const start = rows.find(event => event.type === "tool-start"), end = rows.find(event => event.type === "tool-end");
  const success = rows.find(event => event.type === "state" && event.state === "success");
  const removal = rows.find(event => event.type === "remove");
  assert(rows.some(event => event.type === "injected-idle"), "Idle regression was not exercised");
  assert(start && end && end.at - start.at >= 12000, "Long tool did not finish");
  assert(success && success.at >= end.at, "Task reported success before its tool completed");
  assert(removal && removal.at - success.at >= 9900, "Character left before final completion + ten seconds");
  const report = { passed: true, toolMs: end.at - start.at, lingerMs: removal.at - success.at, events: rows };
  await mkdir(join(root, ".local"), { recursive: true });
  await writeFile(join(root, ".local/companions-activity-smoke.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`PASS real OpenCode: character survives ${report.toolMs} ms tool + delayed idle; leaves ${report.lingerMs} ms after completion`);
} finally {
  if (child?.pid) {
    child.kill("SIGTERM"); const killer = setTimeout(() => child.kill("SIGKILL"), 1500);
    await exited; clearTimeout(killer);
  }
  await new Promise(resolve => stub.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
