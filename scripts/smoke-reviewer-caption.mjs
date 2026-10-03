import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startNativeHost } from "../packages/companions/dist/native-host.js";
import { LocalTts } from "../packages/companions/dist/local-tts.js";
import { SpeechRouter } from "../packages/companions/dist/speech-router.js";
import { configSchema } from "../packages/companions/dist/config.js";

// Actual speakers/PCM, isolated app identity, synthetic public phrases; never accesses the microphone.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, ".local/reviewer-caption-smoke");
const temporary = await mkdtemp(join(tmpdir(), "codexbridge-reviewer-"));
const bundle = join(temporary, "Reviewer QA.app"), identifier = `dev.codexbridge.companions.reviewer-qa.${Date.now()}`;
const exec = promisify(execFile), waiters = new Set(), played = new Map(), captures = [];
const config = configSchema.parse({ dictation: false, speech: "all", tts: { engine: "local" } });
const report = { passed: false, checkedAt: new Date().toISOString(), measurement: "Real local Qwen PCM and macOS callbacks; not acoustic recognition.",
  generated: [], playback: [], captions: [], errors: [], events: [] };
let host, router, tts, nativePID, injecting = false, cleaning = false, captionLength = 0;

function waitFor(name, matches, trigger, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const done = (error, event) => { clearTimeout(timer); waiters.delete(waiter); error ? reject(error) : resolve(event); };
    const timer = setTimeout(() => done(new Error(`${name} timed out`)), timeoutMs);
    const waiter = { matches, resolve: event => done(undefined, event), reject: error => done(error) };
    waiters.add(waiter); try { trigger?.(); } catch (error) { done(error); }
  });
}
async function snapshot(id, stage) {
  // A fresh LaunchServices identity must not request Documents access while rendering PCM.
  const path = join(temporary, `${id}-${stage}.png`);
  const result = await waitFor("Caption snapshot", event => event.type === "snapshot" && event.path === path,
    () => host.send({ type: "snapshot", path, background: "dark" }), 5000);
  assert.equal(result.bubble.characters, captionLength);
  assert.equal(result.bubble.laidOutCharacters, captionLength);
  assert(result.bubble.revealedCharacters >= 0 && result.bubble.revealedCharacters <= captionLength);
  await cp(path, join(output, `${id}-${stage}.png`));
  report.captions.push({ id, stage, ...result.bubble });
}
function receive(event) {
  const { type, id, index, phase, buffering, bufferedSeconds, pid } = event;
  report.events.push({ direction: "receive", at: Date.now(), type, id, index, phase, buffering, bufferedSeconds, pid });
  router?.receive(event);
  if (event.type === "ready") nativePID = event.pid;
  if (event.type === "audio-started") {
    const entry = played.get(event.id);
    if (entry) {
      entry.startedAt = Date.now();
      const capture = snapshot(entry.number, "start"); captures.push(capture); capture.catch(() => {});
    }
  }
  if (event.type === "audio-finished") {
    const entry = played.get(event.id);
    if (entry?.startedAt) {
      report.playback.push({ number: entry.number, engine: entry.engine, phase: event.phase, startMs: entry.startedAt - entry.requestedAt });
      if (event.phase !== "end" && [0, 1, 4].includes(entry.number)) {
        for (const waiter of [...waiters]) waiter.reject(new Error(`Local Reviewer ended with ${event.phase}`));
      }
    }
  }
  if (event.type === "error" || (event.type === "closed" && !cleaning)) {
    for (const waiter of [...waiters]) waiter.reject(new Error(event.code ?? "Native app closed"));
  }
  for (const waiter of [...waiters]) if (waiter.matches(event)) waiter.resolve(event);
}

try {
  await mkdir(output, { recursive: true });
  await cp(join(root, "packages/companions/native/CodexBridge Companions.app"), bundle, { recursive: true });
  await exec("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${identifier}`, join(bundle, "Contents/Info.plist")]);
  await exec("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, bundle]);
  host = await startNativeHost(join(bundle, "Contents/MacOS/Companions"), ["--atlas", join(bundle, "Contents/Resources/team-atlas.png"), "--config", JSON.stringify(config)], receive,
    message => report.errors.push(message));
  tts = new LocalTts({ log: message => report.errors.push(message) });
  // Warm the same worker explicitly; cold-start timing was measured separately.
  const warmup = Date.now();
  await tts.stream({ id: "warmup", text: "Проверяю голос.", voice: "Ono_Anna" }, {
    chunk(audio) { tts.consumed("warmup", audio.index); void unlink(audio.path); },
  });
  report.warmupMs = Date.now() - warmup;
  console.log(JSON.stringify({ phase: "warmup-complete", milliseconds: report.warmupMs }));
  let number = 0, requestedAt = 0;
  router = new SpeechRouter(config, {
    synthesize: request => tts.synthesize(request), consumed: (id, index) => tts.consumed(id, index), dispose: () => tts.dispose(),
    async stream(request, observer, signal) {
      if (injecting) { injecting = false; throw new Error("Synthetic QA failure before audio"); }
      const started = Date.now(), item = { number, voice: request.voice, chunks: [] };
      report.generated.push(item);
      try {
        await tts.stream(request, { start: () => observer.start?.(), chunk(audio) {
          item.chunks.push({ index: audio.index, seconds: audio.duration, arrivedMs: Date.now() - started }); observer.chunk(audio);
        } }, signal);
      } catch (error) { item.error = error.message; throw error; }
    },
  }, event => {
    const { type, audioId, index, chunks } = event;
    report.events.push({ direction: "send", at: Date.now(), type, audioId, index, chunks });
    if (event.type === "caption") captionLength = event.text.length;
    if (["audio-stream-start", "speak"].includes(event.type)) played.set(event.audioId,
      { number, engine: event.type === "speak" ? "macos" : "qwen", requestedAt });
    host.send(event);
  }, message => console.log(JSON.stringify({ warning: message })));
  for (const [index, text] of [
    "Проверю изменения в коде и отмечу ошибки. Затем запущу тесты и посмотрю на результат.",
    "Проверка завершена. Теперь всё работает стабильно.",
    "Проверяю резервный голос. Весь текст остаётся над персонажем.",
    "Продолжаю проверку тем же резервным голосом.",
    "Начинаю новую задачу. Снова проверяю локальный голос.",
  ].entries()) {
    number = index; requestedAt = Date.now();
    router.event({ type: "state", characterId: "reviewer", invocationId: index < 4 ? "one" : "two", role: "reviewer", state: "working",
      activity: "read", appearance: { column: 3, headColumn: 3, bodyColumn: 3, label: "REVIEW" } });
    if (index === 2) injecting = true;
    const done = waitFor("Reviewer playback", event => event.type === "audio-finished" && played.get(event.id)?.number === index && event.phase === "end",
      () => router.event({ type: "speak", characterId: "reviewer", invocationId: index < 4 ? "one" : "two", role: "reviewer", text }));
    const middle = setTimeout(() => {
      const capture = snapshot(index, "middle"); captures.push(capture); capture.catch(() => {});
    }, index < 2 || index === 4 ? 4500 : 1700);
    await done; clearTimeout(middle); await Promise.all(captures);
    await snapshot(index, "end");
    const end = report.captions.findLast(item => item.id === index && item.stage === "end");
    assert.equal(end.revealedCharacters, text.length);
    console.log(JSON.stringify({ number: index, playback: report.playback.at(-1) }));
  }
  assert.deepEqual(report.playback.map(item => item.engine), ["qwen", "qwen", "macos", "macos", "qwen"]);
  assert(report.generated.every(item => item.voice === "Ono_Anna"));
  assert(report.captions.some(item => item.stage === "middle" && item.revealedCharacters > 0 && item.revealedCharacters < item.characters));
  assert.equal(report.errors.length, 0);
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  cleaning = true; for (const waiter of [...waiters]) waiter.reject(new Error("QA ended"));
  router?.dispose(); tts?.dispose(); host?.close();
  if (nativePID) {
    for (let attempt = 0; attempt < 40; attempt++) {
      try { process.kill(nativePID, 0); } catch { report.processReaped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  await exec("/usr/bin/defaults", ["delete", identifier]).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed, error: report.error, output }));
}
