import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startNativeHost } from "../packages/companions/dist/native-host.js";
import { LocalTts } from "../packages/companions/dist/local-tts.js";
import { SpeechRouter } from "../packages/companions/dist/speech-router.js";
import { configSchema } from "../packages/companions/dist/config.js";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Requires Apple Silicon macOS");
const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.argv.find(value => value.startsWith("--bundle="))?.slice(9)
  ?? join(root, "packages/companions/native/CodexBridge Companions.app");
const baseline = process.argv.includes("--baseline");
const label = baseline ? "voice-smoke-baseline" : "voice-smoke";
const output = join(root, ".local", label);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(root, ".local/voice-qa-"));
const captures = await mkdtemp(join(tmpdir(), "codexbridge-voice-captures-"));
const bundle = join(temporary, "Voice Smoke.app");
const identifier = `dev.codexbridge.companions.voice-smoke.${Date.now()}`;
const exec = promisify(execFile);
const config = configSchema.parse({ enabled: true, showOnStart: false, dictation: false, tts: { engine: "local" } });
const samples = [
  ["coordinator", "LEAD", "Я соберу план и распределю задачи."],
  ["developer", "CODE", "Проверю код и запущу тесты."],
  ["researcher", "RESEARCH", "Найду документацию и проверю источники."],
  ["reviewer", "REVIEW", "Проверю изменения и отмечу ошибки."],
];
const report = { checkedAt: new Date().toISOString(), passed: false, baseline,
  measurement: "Real Qwen generation, AVAudioPlayer callbacks and rendered live captions; no acoustic microphone verification.",
  generated: [], playback: [], snapshots: [], errors: [] };
const waiters = new Set(), utterances = new Map(), snapshots = [];
let host, router, tts, nativePID, cleaning = false, stateTimer, timeout, rejectFatal;
const fatal = new Promise((_, reject) => { rejectFatal = reject; }); fatal.catch(() => undefined);
const fail = message => {
  if (cleaning) return;
  report.errors.push(message);
  for (const waiter of [...waiters]) waiter.reject(new Error(message));
  rejectFatal(new Error(message));
};

/** Register before sending IPC so a quick native reply cannot be lost. */
function waitFor(name, matches, trigger, duration = 6000) {
  return new Promise((resolve, reject) => {
    const done = (error, value) => { clearTimeout(timer); waiters.delete(waiter); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => done(new Error(`${name} timed out`)), duration);
    const waiter = { matches, resolve: value => done(undefined, value), reject: error => done(error) };
    waiters.add(waiter);
    try { trigger?.(); } catch (error) { done(error); }
  });
}

async function capture(name, expectedText) {
  const path = join(captures, `${name}.png`);
  const response = await waitFor(`Live caption ${name}`, event => event.type === "snapshot" && event.path === path,
    () => host.send({ type: "snapshot", path, background: "dark" }));
  // No caption override: inspect the real speech/caption path.
  assert.equal(response.bubble?.characters, expectedText.length, "Live caption is missing or truncated");
  assert.equal(response.bubble?.laidOutCharacters, expectedText.length, "Live caption glyphs were not laid out");
  if (expectedText) assert(response.bubble.visibleHeight > 0 && response.bubble.visibleHeight <= 168, "Caption has no visible bounds");
  const saved = join(output, `${name}.png`); await copyFile(path, saved);
  assert((await stat(saved)).size > 1000, "Native screenshot is empty");
  report.snapshots.push({ name, path: saved, ...response.bubble });
}

function receive(event) {
  if (event.type === "ready") { nativePID = event.pid; report.graphics = event.graphics; }
  if (event.type === "closed" && !cleaning) fail("Native companion closed during visible speech");
  if (event.type === "error") fail(`Native error: ${event.code ?? "unknown"}`);
  if (event.type === "speech" && event.phase === "start") {
    const entry = [...utterances.values()].find(item => item.characterId === event.characterId && !item.started);
    if (!entry) { fail("Unmatched native speech start"); return; }
    entry.started = true;
    const snapshot = capture(`${entry.role}-speaking`, entry.text);
    snapshots.push(snapshot); snapshot.catch(error => fail(error.message));
  }
  if (event.type === "audio-finished") {
    const entry = utterances.get(event.id);
    if (!entry?.started || entry.finished || event.phase !== "end") { fail("Native audio did not finish exactly once"); return; }
    entry.finished = true;
    report.playback.push({ role: entry.role, phase: event.phase, characterId: entry.characterId });
    console.log(JSON.stringify({ playback: entry.role, phase: event.phase }));
  }
  for (const waiter of [...waiters]) if (waiter.matches(event)) waiter.resolve(event);
  router?.receive(event);
}

async function exercise() {
  host = await startNativeHost(join(bundle, "Contents/MacOS/Companions"), ["--atlas", join(bundle, "Contents/Resources/team-atlas.png"),
    "--config", JSON.stringify(config)], receive, fail);
  assert.equal(report.graphics, true, "Voice smoke requires real character artwork");
  tts = new LocalTts({ log: fail });
  router = new SpeechRouter(config, {
    async synthesize(request) {
      const started = Date.now(); const audio = await tts.synthesize(request);
      report.generated.push({ voice: request.voice, audioSeconds: audio.duration, generationSeconds: (Date.now() - started) / 1000 });
      return audio;
    }, dispose: () => tts.dispose(),
  }, event => {
    if (event.type === "play-audio") utterances.set(event.audioId, { ...event, started: false, finished: false });
    try { host.send(event); } catch { router.dispose(); fail("Native input closed during voice playback"); }
  }, fail);
  const characters = samples.map(([role, name], column) => ({ type: "state", characterId: `voice-real-${column}`, role,
    state: "thinking", appearance: { column, headColumn: column, bodyColumn: column, label: name } }));
  characters.forEach(event => router.event(event));
  await waitFor("Visible real characters", event => event.type === "window" && event.count === 4 && event.visible && event.rendering,
    () => host.send({ type: "window-status" }));
  const visibleSince = Date.now(), states = ["thinking", "working", "waiting", "success", "error", "idle"];
  let state = 0;
  stateTimer = setInterval(() => {
    characters.forEach(event => router.event({ ...event, state: states[state % states.length] })); state++;
  }, 700);
  if (!baseline) {
    await waitFor("Native mute", event => event.type === "speech-control" && event.action === "mute" && event.muted === true,
      () => host.send({ type: "mute", muted: true }));
    router.event({ type: "speak", characterId: characters[0].characterId, role: "coordinator", text: samples[0][2] });
    await capture("muted-public-caption", samples[0][2]);
    assert.equal(report.generated.length, 0, "Mute started a synthesis request");
    assert.equal(utterances.size, 0, "Mute started native audio");
    router.event({ type: "stop", characterId: characters[0].characterId });
    await capture("cancel-clears-caption", "");
    await waitFor("Native unmute", event => event.type === "speech-control" && event.action === "mute" && event.muted === false,
      () => host.send({ type: "mute", muted: false }));
  }
  const completed = waitFor("Four real native playbacks", () => report.playback.length === 4, undefined, 180_000);
  completed.catch(() => undefined);
  const speak = index => router.event({ type: "speak", characterId: characters[index].characterId,
    role: samples[index][0], text: samples[index][2] });
  speak(0);
  if (!baseline) {
    await capture("public-caption-before-synthesis", samples[0][2]);
    assert.equal(report.generated.length, 0, "Caption arrived after Qwen generation");
    assert.equal(utterances.size, 0, "Caption waited for native playback");
  }
  for (let index = 1; index < samples.length; index++) speak(index);
  await completed;
  await Promise.all(snapshots);
  await new Promise(resolve => { timeout = setTimeout(resolve, Math.max(0, 75_000 - (Date.now() - visibleSince))); });
  const final = await waitFor("Characters survive speech and state changes", event => event.type === "window" && event.count === 4 && event.visible && event.rendering,
    () => host.send({ type: "window-status" }));
  report.visibleSeconds = (Date.now() - visibleSince) / 1000;
  report.finalWindow = { count: final.count, visible: final.visible, rendering: final.rendering };
  assert.equal(report.snapshots.length, baseline ? 4 : 7);
  assert.equal(report.playback.length, 4);
  assert.equal(new Set(report.generated.map(item => item.voice)).size, 4);
  assert.equal(report.errors.length, 0);
  report.passed = true;
}

try {
  await cp(source, bundle, { recursive: true });
  await exec("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${identifier}`, join(bundle, "Contents/Info.plist")]);
  await exec("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, bundle]);
  await Promise.race([exercise(), fatal]);
} catch (error) {
  report.passed = false; report.errors.push(error.message); console.error(error.message); process.exitCode = 1;
} finally {
  cleaning = true; clearInterval(stateTimer); clearTimeout(timeout);
  for (const waiter of [...waiters]) waiter.reject(new Error("Voice smoke ended"));
  router?.dispose(); tts?.dispose(); host?.close();
  if (nativePID) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(nativePID, 0); }
      catch (error) { if (error.code === "ESRCH") report.processReaped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!report.processReaped) { report.passed = false; report.errors.push("QA process cleanup was not verified"); process.exitCode = 1; }
  }
  await exec("/usr/bin/defaults", ["delete", identifier]).catch(() => undefined);
  await rm(temporary, { recursive: true, force: true }); await rm(captures, { recursive: true, force: true });
  await writeFile(join(root, ".local", `${label}.json`), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed, playedVoices: report.playback.length, liveCaptions: report.snapshots.length }));
}
