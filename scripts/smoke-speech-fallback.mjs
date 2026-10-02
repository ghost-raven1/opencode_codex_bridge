import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startNativeHost } from "../packages/companions/dist/native-host.js";
import { SpeechRouter } from "../packages/companions/dist/speech-router.js";
import { configSchema } from "../packages/companions/dist/config.js";

// Exercise real AVAudioPlayer failure and AVSpeechSynthesizer recovery without loading MLX.
if (process.platform !== "darwin") throw new Error("Requires macOS");
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "codexbridge-playback-qa-"));
const bundle = join(temporary, "Playback QA.app");
const identifier = `dev.codexbridge.companions.playback-qa.${Date.now()}`;
const exec = promisify(execFile), entries = [], finished = [], logs = [];
const config = configSchema.parse({ dictation: false, tts: { engine: "local" } });
let host, router, pid, cleaning = false, timeout, resolveDone, rejectDone;
const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
done.catch(() => undefined);
const report = { passed: false, measurement: "Real native missing-WAV error, system-voice completion and queued WAV playback; no microphone recording." };

/** A short silent fixture checks WAV playback and ordering; it does not imitate synthesized speech. */
function silence() {
  const samples = 4_800, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40); return wav;
}

try {
  await cp(join(root, "packages/companions/native/CodexBridge Companions.app"), bundle, { recursive: true });
  await exec("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${identifier}`, join(bundle, "Contents/Info.plist")]);
  await exec("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, bundle]);
  const next = join(temporary, "next.wav"); await writeFile(next, silence());
  host = await startNativeHost(join(bundle, "Contents/MacOS/Companions"), ["--config", JSON.stringify(config)], event => {
    if (event.type === "ready") pid = event.pid;
    if (event.type === "closed" && !cleaning) rejectDone(new Error("Native player closed during fallback"));
    if (event.type === "audio-finished") {
      const entry = entries.find(entry => entry.audioId === event.id);
      finished.push({ type: entry?.type, characterId: entry?.characterId, id: event.id, phase: event.phase });
      if (finished.length === 3) resolveDone();
    }
    router?.receive(event);
  }, message => rejectDone(new Error(message)));
  let generated = 0;
  router = new SpeechRouter(config, {
    async synthesize() { return { path: ++generated === 1 ? join(temporary, "missing.wav") : next, duration: 0.2, sampleRate: 24_000 }; },
    dispose() {},
  }, event => {
    if (event.type === "play-audio" || event.type === "speak") entries.push(event);
    host.send(event);
  }, message => logs.push(message));
  timeout = setTimeout(() => rejectDone(new Error("Playback fallback timed out")), 30_000);
  router.event({ type: "speak", characterId: "first", role: "coordinator", text: "Проверка резервного голоса." });
  router.event({ type: "speak", characterId: "next", role: "developer", text: "Следующая реплика." });
  await done;
  assert.deepEqual(finished.map(({ type, characterId, phase }) => ({ type, characterId, phase })), [
    { type: "play-audio", characterId: "first", phase: "error" },
    { type: "speak", characterId: "first", phase: "end" },
    { type: "play-audio", characterId: "next", phase: "end" },
  ]);
  assert.equal(new Set(finished.map(event => event.id)).size, 3, "Retry reused a completed playback ID");
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  cleaning = true; clearTimeout(timeout); router?.dispose(); host?.close();
  if (pid) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === "ESRCH") report.processReaped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!report.processReaped) { report.passed = false; report.error = "QA process did not exit"; process.exitCode = 1; }
  }
  await exec("/usr/bin/defaults", ["delete", identifier]).catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
  await mkdir(join(root, ".local"), { recursive: true });
  await writeFile(join(root, ".local/speech-fallback-smoke.json"), JSON.stringify({ ...report, finished, logs }, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
