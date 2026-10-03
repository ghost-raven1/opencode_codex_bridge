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
const reviewer = process.argv.includes("--reviewer");
const partial = process.argv.includes("--partial-failure");
const injected = !partial && (recovery || process.argv.includes("--inject-failure"));
const exec = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checkedAt: new Date().toISOString(), passed: false, injected, recovery, partial,
  measurement: "Real OpenCode task, Codex model, Qwen synthesis and native speech callbacks; not an acoustic recording." };
let child, exited, endpoint, stderr = "";
const rows = async () => (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
const isPlayback = event => event.channel === "native-send" && ["speak", "play-audio", "audio-stream-start"].includes(event.type);
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
    const plays = events.filter(isPlayback);
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
  if (reviewer) config.agent.reviewer = { mode: "subagent", description: "Read-only code reviewer for isolated speech QA",
    prompt: "Проверь только указанные файлы. Не меняй файлы. Ответь кратко по-русски.", permission: { edit: "deny", write: "deny", apply_patch: "deny" } };
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
      CODEXBRIDGE_QA_FAIL_AFTER_AUDIO: partial ? "1" : "0",
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
  const prompt = `Это тестовое задание для проверки голоса. Работай только с total.js и total.test.js в текущем проекте. Сначала обязательно вызови companion_intro с кратким русским вступлением о начале проверки, чтобы протестировать этот инструмент. Делегируй субагенту ${reviewer ? "reviewer" : "tester"} через task чтение этих двух файлов и поиск причины провала теста без изменения файлов; попроси короткий ответ по-русски. Затем сам исправь подсчёт с учётом quantity, запусти node --test total.test.js через bash. Не устанавливай пакеты. В конце напиши связный русский ответ на 600–750 символов без кода и Markdown: причина, исправление, результаты тестов и простой пример расчёта. Это нужно для проверки длинной речи. Никаких других файлов и действий.`;
  const reply = await request(`/session/${session.id}/message`, {
    model: { providerID: "codexbridge", modelID: config.model.slice("codexbridge/".length) },
    agent: "build", parts: [{ type: "text", text: prompt }],
  });
  assert(!reply.info?.error, JSON.stringify(reply.info?.error));
  const history = await request(`/session/${session.id}/message`);
  const tools = history.flatMap(message => message.parts ?? []).filter(part => part.type === "tool");
  report.tools = tools.map(part => ({ name: part.tool, status: part.state?.status }));
  assert(tools.some(part => part.tool === "task" && part.state?.status === "completed"), "Subagent task did not complete");
  assert(tools.some(part => part.tool === "companion_intro" && part.state?.status === "completed"), "Model-authored introduction was not exercised");
  assert(tools.some(part => part.tool === "bash" && part.state?.status === "completed"), "Model did not run tests");
  await exec(process.execPath, ["--test", "total.test.js"], { cwd: project });
  report.taskPassed = true;
  console.log(JSON.stringify({ phase: "task-complete", waitingForSpeech: true }));
  await drain();
  if (recovery) {
    const before = await rows();
    const playbacks = before.filter(isPlayback).length;
    assert(before.some(event => event.type === (partial ? "injected-partial-failure" : "injected-failure")), "Local failure was not injected");
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
    assert.equal(after.filter(isPlayback).length,
      playbacks, "Recovery replayed stale speech");
    console.log(JSON.stringify({ phase: "voice-restored", testingNextReply: true }));
    const next = await request(`/session/${session.id}/message`, {
      model: { providerID: "codexbridge", modelID: config.model.slice("codexbridge/".length) }, agent: "build",
      parts: [{ type: "text", text: "Проверка следующей реплики после восстановления голоса. Не вызывай инструменты и ничего не меняй. Ответь только: Голос снова готов. Проверка завершена." }],
    });
    assert(!next.info?.error, JSON.stringify(next.info?.error));
    await drain(playbacks + 1);
    const resumed = (await rows()).filter(event => event.at > restored.at && isPlayback(event) && event.type !== "speak");
    assert(resumed.length > 0, "Next model reply did not return to local audio");
    report.recoveryPassed = true;
  }
  const events = await rows();
  report.activities = [...new Set(events.filter(event => event.channel === "native-send" && event.type === "state").map(event => event.activity).filter(Boolean))];
  for (const action of ["read", "delegate", "test"]) assert(report.activities.includes(action), `No native animation for ${action}`);
  report.statuses = [...new Set(events.filter(event => event.channel === "status").map(event => event.phase))];
  assert(report.statuses.includes("system") || report.statuses.includes("local"), "No observed playback status");
  const started = events.filter(isPlayback);
  const completed = events.filter(event => event.channel === "native-receive" && event.type === "audio-finished");
  report.gaps = started.slice(1).map((event, index) => {
    const previous = completed.find(item => item.id === started[index].audioId && item.phase === "end");
    const audible = events.find(item => item.type === "audio-started" && item.id === event.audioId);
    return { audioId: event.audioId, engine: event.type !== "speak" ? "local" : "macos",
      queuedAtPreviousEnd: previous?.queued ?? null,
      dispatchGapMs: previous ? event.at - previous.at : null,
      playbackGapMs: previous && audible ? audible.at - previous.at : null };
  });
  const queuedGaps = report.gaps.filter(gap => gap.queuedAtPreviousEnd > 0 && gap.dispatchGapMs !== null);
  report.maxQueuedDispatchGapMs = queuedGaps.length ? Math.max(...queuedGaps.map(gap => gap.dispatchGapMs)) : null;
  // Dispatch is immediate for streams. Actual cold startup uses its own twenty-second deadline.
  assert(queuedGaps.every(gap => gap.dispatchGapMs < 22_000), "An already queued phrase exceeded its fresh startup budget");
  assert(started.length >= 3, "Too few phrases to exercise speech stability");
  for (const event of started) assert(completed.some(item => item.id === event.audioId),
    `Utterance ${event.audioId} (${event.type}) did not terminate`);
  assert(new Set(started.map(event => event.characterId)).size >= 2, "Child session speech was not exercised");
  if (injected) assert(started.some(event => event.type === "speak"), "Native system voice fallback was not exercised");
  report.streams = streamMetrics(events);
  report.completedPlaybacks = completed.filter(event => event.phase === "end").length;
  report.interruptedPlaybacks = completed.filter(event => event.phase !== "end").length;
  report.continuousSpeech = report.streams.every(stream => stream.outcome === "end" && stream.underruns.length === 0);
  if (partial) {
    assert(events.some(event => event.type === "injected-partial-failure"), "No failure was injected after audible PCM");
    assert(events.some(event => event.reason === "partial-stream-failure"), "Partial failure was not reported");
    assert(started.some(event => event.type === "speak"), "Following segments did not use macOS");
  }
  assert(report.streams.some(stream => stream.chunks > 1 && stream.firstSoundMs !== null), "No real multichunk playback observed");
  report.playbacks = started.length; report.localPlaybacks = started.filter(event => event.type !== "speak").length;
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
  const output = join(root, ".local", `opencode-speech-stream-${reviewer ? "reviewer-" : ""}${partial ? recovery ? "partial-recovery" : "partial" : recovery ? "recovery" : injected ? "fallback" : "natural"}.json`);
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  await rm(temporary, { recursive: true, force: true });
  const { events, ...summary } = report; console.log(JSON.stringify({ ...summary, output }));
}

/** Timings describe PCM callbacks and generation, independently of gaps in model output. */
function streamMetrics(events) {
  return events.filter(event => event.channel === "native-send" && event.type === "audio-stream-start").map(start => {
    const parts = events.filter(event => event.id === start.audioId);
    const request = parts.find(event => event.channel === "tts" && event.type === "start");
    const chunks = parts.filter(event => event.channel === "tts" && event.type === "chunk");
    const audible = parts.find(event => event.type === "audio-started");
    const end = parts.find(event => event.channel === "tts" && event.type === "stream-end");
    const consumed = parts.filter(event => event.type === "audio-chunk-consumed");
    const stalls = parts.filter(event => event.type === "audio-buffering" && event.buffering).map(stall => {
      const resume = parts.find(event => event.at >= stall.at &&
        ((event.type === "audio-buffering" && !event.buffering) || event.type === "audio-finished"));
      return resume ? resume.at - stall.at : null;
    });
    const pcmGaps = consumed.slice(1).map((event, index) => event.at - consumed[index].at -
      (chunks.find(chunk => chunk.index === event.index)?.seconds ?? 0) * 1000);
    return { audioId: start.audioId, chunks: chunks.length, seconds: chunks.reduce((sum, chunk) => sum + chunk.seconds, 0),
      firstChunkMs: chunks[0] && request ? chunks[0].at - request.at : null,
      firstSoundMs: audible && request ? audible.at - request.at : null,
      synthesisMs: end && request ? end.at - request.at : null,
      playbackBeforeSynthesisEnd: Boolean(audible && end && audible.at < end.at),
      maxPcmGapMs: pcmGaps.length ? Math.round(Math.max(0, ...pcmGaps)) : 0, underruns: stalls,
      outcome: parts.find(event => event.type === "audio-finished")?.phase ?? "missing" };
  });
}
