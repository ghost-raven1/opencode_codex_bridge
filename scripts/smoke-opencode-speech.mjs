import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// A real model repairs a real fixture through OpenCode and the unchanged companions plugin.
if (process.platform !== "darwin") throw new Error("Requires macOS");
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "codexbridge-speech-task-"));
const project = join(temporary, "project"), runtime = join(temporary, "runtime");
const trace = join(temporary, "events.jsonl");
const bundle = join(runtime, "packages/companions/native/CodexBridge Companions.app");
const identifier = `dev.codexbridge.companions.task-qa.${Date.now()}`;
const recovery = process.argv.includes("--recover-voice");
const injected = recovery || process.argv.includes("--inject-failure");
const exec = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checkedAt: new Date().toISOString(), passed: false, injected, recovery,
  measurement: "Real OpenCode task, Codex model, Qwen synthesis and native speech callbacks; not an acoustic recording." };
let child, exited, endpoint, stderr = "";
const rows = async () => (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
async function request(path, body, timeout = 180_000) {
  const result = await fetch(endpoint + path, { method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout) });
  assert.equal(result.status, 200, `OpenCode ${path}: HTTP ${result.status}`);
  return result.json();
}
async function drain(minPlaybacks = 1) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const events = await rows(), pending = events.findLast(event => event.channel === "router" && event.type === "pending");
    const plays = events.filter(event => event.channel === "native-send" && ["speak", "play-audio"].includes(event.type));
    if (pending?.count === 0 && plays.length >= minPlaybacks && events.some(event => event.type === "audio-finished")) return;
    await delay(500);
  }
  throw new Error("Speech queue did not drain within four minutes");
}

try {
  await mkdir(project, { recursive: true }); await mkdir(join(runtime, "packages/companions"), { recursive: true });
  await mkdir(join(runtime, ".local"), { recursive: true });
  await writeFile(join(runtime, "package.json"), '{"type":"module"}');
  await cp(join(root, "packages/companions/dist"), join(runtime, "packages/companions/dist"), { recursive: true });
  await cp(join(root, "packages/companions/native/CodexBridge Companions.app"), bundle, { recursive: true });
  await symlink(join(root, "node_modules"), join(runtime, "node_modules"));
  await symlink(join(root, ".local/tts"), join(runtime, ".local/tts"));
  await symlink(join(root, "packages/companions/tts"), join(runtime, "packages/companions/tts"));
  await exec("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${identifier}`, join(bundle, "Contents/Info.plist")]);
  await exec("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, bundle]);
  const config = JSON.parse(await readFile(join(root, ".local/profiles/companions/opencode.json"), "utf8"));
  for (const server of Object.values(config.mcp)) server.enabled = false;
  config.plugin = config.plugin.map(path => path.endsWith("/companions.mjs")
    ? pathToFileURL(join(root, "scripts/speech-task-observer.mjs")).href : path);
  config.permission = { "*": "deny", read: "allow", edit: "allow", write: "allow", apply_patch: "allow",
    bash: "allow", task: "allow", glob: "allow", grep: "allow", list: "allow", companion_intro: "allow" };
  config.agent = { ...config.agent, title: { disable: true }, summary: { disable: true } };
  await writeFile(join(temporary, "opencode.json"), JSON.stringify(config));
  await writeFile(join(temporary, "smart-voice-notify.jsonc"), '{"enabled":false}');
  await writeFile(join(temporary, "companions.json"), JSON.stringify({ enabled: true, dictation: false,
    speech: "all", tts: { engine: "local" }, maxSpeechLength: 900 }));
  await writeFile(join(project, "package.json"), '{"type":"module"}');
  await writeFile(join(project, "total.js"), 'export const total = items => items.reduce((sum, item) => sum + item.price, 0);\n');
  await writeFile(join(project, "total.test.js"), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from './total.js';
test('includes quantity', () => assert.equal(total([{price: 10, quantity: 3}, {price: 4, quantity: 2}]), 38));
test('empty basket', () => assert.equal(total([]), 0));
`);
  child = spawn("opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: project, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      PATH: `${join(root, ".local/bin")}:${process.env.PATH}`, OPENCODE_CONFIG_DIR: temporary,
      OPENCODE_CONFIG: join(temporary, "opencode.json"), OPENCODE_DISABLE_MODELS_FETCH: "true",
      XDG_CONFIG_HOME: join(temporary, "config"), XDG_DATA_HOME: join(temporary, "data"),
      XDG_STATE_HOME: join(temporary, "state"), XDG_CACHE_HOME: join(temporary, "cache"),
      CODEXBRIDGE_QA_RUNTIME: runtime, CODEXBRIDGE_QA_TRACE: trace, CODEXBRIDGE_QA_FAIL_REQUEST: injected ? "2" : "0",
      CODEXBRIDGE_QA_RECOVER: recovery ? "1" : "0",
      CODEXBRIDGE_DATA_DIR: join(temporary, "companion-data"),
    },
  });
  exited = new Promise(resolve => child.once("exit", resolve));
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OpenCode startup timeout: ${stderr}`)), 40_000);
    let output = "";
    child.stdout.on("data", chunk => {
      output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`OpenCode exited ${code}`)); });
  });
  const auth = await fetch(endpoint + "/auth/codexbridge", { method: "PUT",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "api", key: "codexbridge-managed" }) });
  assert.equal(auth.status, 200);
  const session = await request("/session", {});
  report.sessionId = session.id; report.model = config.model;
  console.log(JSON.stringify({ phase: "task-start", sessionId: session.id, injected }));
  const prompt = "Это тестовое задание для проверки голоса. Работай только с total.js и total.test.js в текущем проекте. Кратко сообщи по-русски, что начинаешь проверку. Делегируй субагенту tester через task чтение этих двух файлов и поиск причины провала теста без изменения файлов; попроси короткий ответ по-русски. Затем сам исправь подсчёт с учётом quantity, запусти node --test total.test.js через bash. Не устанавливай пакеты. В конце напиши три коротких русских предложения: причина, исправление, результат тестов. Никаких других файлов и действий.";
  const reply = await request(`/session/${session.id}/message`, {
    model: { providerID: "codexbridge", modelID: config.model.slice("codexbridge/".length) },
    agent: "build", parts: [{ type: "text", text: prompt }],
  });
  assert(!reply.info?.error, JSON.stringify(reply.info?.error));
  const history = await request(`/session/${session.id}/message`);
  const tools = history.flatMap(message => message.parts ?? []).filter(part => part.type === "tool");
  assert(tools.some(part => part.tool === "task" && part.state?.status === "completed"), "Subagent task did not complete");
  assert(tools.some(part => part.tool === "companion_intro" && part.state?.status === "completed"), "Model-authored introduction was not exercised");
  assert(tools.some(part => part.tool === "bash" && part.state?.status === "completed"), "Model did not run tests");
  await exec(process.execPath, ["--test", "total.test.js"], { cwd: project });
  report.taskPassed = true;
  console.log(JSON.stringify({ phase: "task-complete", waitingForSpeech: true }));
  await drain();
  if (recovery) {
    const before = await rows();
    const playbacks = before.filter(event => event.channel === "native-send" && ["speak", "play-audio"].includes(event.type)).length;
    assert(before.some(event => event.type === "injected-failure"), "Local failure was not injected");
    assert(before.findLast(event => event.channel === "status")?.canRecover, "Drained failed voice was not recoverable");
    await writeFile(join(runtime, "recover-speech"), "explicit QA menu-equivalent request\n");
    const deadline = Date.now() + 15_000;
    let restored;
    while (Date.now() < deadline) {
      restored = (await rows()).findLast(event => event.channel === "status" && event.reason === "restored");
      if (restored) break;
      await delay(100);
    }
    assert(restored, "Explicit voice recovery did not complete");
    await delay(400);
    const after = await rows();
    assert.equal(after.filter(event => event.type === "reset-speech").length, 1, "Recovery reset must happen once");
    assert.equal(after.filter(event => event.channel === "native-send" && ["speak", "play-audio"].includes(event.type)).length,
      playbacks, "Recovery replayed stale speech");
    console.log(JSON.stringify({ phase: "voice-restored", testingNextReply: true }));
    const next = await request(`/session/${session.id}/message`, {
      model: { providerID: "codexbridge", modelID: config.model.slice("codexbridge/".length) }, agent: "build",
      parts: [{ type: "text", text: "Проверка следующей реплики после восстановления голоса. Не вызывай инструменты и ничего не меняй. Ответь только: Голос снова готов. Проверка завершена." }],
    });
    assert(!next.info?.error, JSON.stringify(next.info?.error));
    await drain(playbacks + 1);
    const resumed = (await rows()).filter(event => event.at > restored.at && event.channel === "native-send" && event.type === "play-audio");
    assert(resumed.length > 0, "Next model reply did not return to local audio");
    report.recoveryPassed = true;
  }
  const events = await rows();
  report.statuses = [...new Set(events.filter(event => event.channel === "status").map(event => event.phase))];
  assert(report.statuses.includes("system") || report.statuses.includes("local"), "No observed playback status");
  const started = events.filter(event => event.channel === "native-send" && ["speak", "play-audio"].includes(event.type));
  const completed = events.filter(event => event.channel === "native-receive" && event.type === "audio-finished");
  report.gaps = started.slice(1).map((event, index) => {
    const previous = completed.find(item => item.id === started[index].audioId && item.phase === "end");
    const audible = events.find(item => item.type === "audio-started" && item.id === event.audioId);
    return { audioId: event.audioId, engine: event.type === "play-audio" ? "local" : "macos",
      queuedAtPreviousEnd: previous?.queued ?? null,
      dispatchGapMs: previous ? event.at - previous.at : null,
      playbackGapMs: previous && audible ? audible.at - previous.at : null };
  });
  const queuedGaps = report.gaps.filter(gap => gap.queuedAtPreviousEnd > 0 && gap.dispatchGapMs !== null);
  report.maxQueuedDispatchGapMs = queuedGaps.length ? Math.max(...queuedGaps.map(gap => gap.dispatchGapMs)) : null;
  // Account for IPC/scheduling jitter; the production wait budget is four seconds.
  assert(queuedGaps.every(gap => gap.dispatchGapMs < 6000), "An already queued phrase waited over six seconds");
  assert(started.length >= 3, "Too few phrases to exercise speech stability");
  for (const event of started) assert(completed.some(item => item.id === event.audioId && item.phase === "end"),
    `Utterance ${event.audioId} (${event.type}) did not finish`);
  assert(new Set(started.map(event => event.characterId)).size >= 2, "Child session speech was not exercised");
  if (injected) assert(started.some(event => event.type === "speak"), "Native system voice fallback was not exercised");
  report.playbacks = started.length; report.localPlaybacks = started.filter(event => event.type === "play-audio").length;
  report.systemPlaybacks = started.filter(event => event.type === "speak").length;
  report.characters = new Set(started.map(event => event.characterId)).size;
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (endpoint) await request("/instance/dispose", {}, 5000).catch(() => undefined);
  if (child?.pid) {
    child.kill("SIGTERM"); const killer = setTimeout(() => child.kill("SIGKILL"), 1500);
    await exited; clearTimeout(killer);
  }
  // Identify only this unique QA bundle; never signal the user's running companion.
  const processes = await exec("/bin/ps", ["-axo", "pid=,command="]).catch(() => ({ stdout: "" }));
  const native = processes.stdout.split("\n").filter(line => line.includes(join(bundle, "Contents/MacOS/Companions")))
    .map(line => Number(line.trim().split(/\s+/)[0]));
  for (const pid of native) { try { process.kill(pid, "SIGTERM"); } catch {} }
  await delay(1800);
  for (const pid of native) { try { process.kill(pid, "SIGKILL"); } catch {} }
  report.events = await rows();
  const diagnosticsRoot = join(temporary, "companion-data/diagnostics");
  const diagnosticEvents = [];
  for (const directory of await readdir(diagnosticsRoot).catch(() => [])) {
    for (const file of await readdir(join(diagnosticsRoot, directory))) {
      if (!/^companions\.jsonl(?:\.[12])?$/.test(file)) continue;
      const content = await readFile(join(diagnosticsRoot, directory, file), "utf8");
      diagnosticEvents.push(...content.trim().split("\n").filter(Boolean).map(JSON.parse));
    }
  }
  report.diagnostics = Object.fromEntries([...new Set(diagnosticEvents.map(event => event.event))]
    .map(name => [name, diagnosticEvents.filter(event => event.event === name).length]));
  if (report.passed && (!report.diagnostics["native-connect"] || !report.diagnostics["speech-end"])) {
    report.passed = false; report.error = "Real task did not produce native/speech diagnostics"; process.exitCode = 1;
  }
  await exec("/usr/bin/defaults", ["delete", identifier]).catch(() => undefined);
  await mkdir(join(root, ".local"), { recursive: true });
  const output = join(root, ".local", `opencode-speech-${recovery ? "recovery" : injected ? "fallback" : "natural"}.json`);
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  await rm(temporary, { recursive: true, force: true });
  const { events, ...summary } = report; console.log(JSON.stringify({ ...summary, output }));
}
