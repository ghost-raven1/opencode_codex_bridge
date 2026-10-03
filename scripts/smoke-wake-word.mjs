import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startNativeHost } from "../packages/companions/dist/native-host.js";

// --acoustic uses existing permissions, plays synthetic test audio and never connects to OpenCode.
const root = fileURLToPath(new URL("../", import.meta.url));
const binary = join(root, "packages/companions/native/CodexBridge Companions.app/Contents/MacOS/Companions");
const acoustic = process.argv.includes("--acoustic");
const requestPermissions = process.argv.includes("--request-permissions");
const testMusic = !process.argv.includes("--no-music");
const temporary = await mkdtemp(join(tmpdir(), "codexbridge-wake-test-"));
let host, output, waiting, canceled = false;
const report = { acoustic, woke: false, dictationStarted: false, submitted: false, keywordRemoved: false,
  backgroundDeliveredText: false, musicAudible: false, musicStrength: 0, tempo: 0, musicListening: false, errors: [] };

function receive(event) {
  if (event.type === "diagnostic" && event.event === "wake-state" && event.state === "triggered") report.woke = true;
  if (event.type === "dictation" && event.active) report.dictationStarted = true;
  if (event.type === "transcript" || event.type === "voice-command") {
    if (!report.woke) report.backgroundDeliveredText = true;
    report.deliveredDraft = true;
    report.textHints = { request: /проверь/iu.test(event.text ?? ""), test: /тест/iu.test(event.text ?? ""),
      send: /отправить/iu.test(event.text ?? ""), keyword: /open\s*code|[оo](?:у)?пен\s*код/iu.test(event.text ?? "") };
    if (event.type === "voice-command" && event.command === "submit") {
      report.submitted = true;
      report.keywordRemoved = typeof event.text === "string" && !/open\s*code|[оo](?:у)?пен\s*код/iu.test(event.text) && /тест/iu.test(event.text);
    }
  }
  if (event.type === "error") report.errors.push(String(event.code ?? "native-error"));
  if (waiting?.type === event.type) { const { resolve, timer } = waiting; waiting = undefined; clearTimeout(timer); resolve(event); }
}

function request(type, command) {
  assert(!canceled, "Acoustic test canceled");
  assert(!waiting, "Status requests must be sequential");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting = undefined; reject(new Error(`${type} timed out`)); }, 5000);
    waiting = { type, timer, resolve }; host.send({ type: command });
  });
}

async function start(enabled) {
  // NSArgumentDomain overrides preferences for this process only, preserving user opt-ins.
  host = await startNativeHost(binary, ["-companions.dictationEnabled", "YES", "-companions.wakeWordEnabled", enabled ? "YES" : "NO",
    "-companions.musicEnabled", enabled && testMusic ? "YES" : "NO", "--config", JSON.stringify({ dictation: true, wakeWord: enabled,
      speech: "off", language: "ru-RU" })], receive, () => {});
}
async function close() { host?.close(); host = undefined; await delay(600); }
async function play(command, args) {
  await new Promise((resolve, reject) => {
    output = spawn(command, args, { stdio: "ignore" });
    output.once("error", reject); output.once("exit", code => code === 0 ? resolve() : reject(new Error("Test audio did not play")));
  });
  output = undefined;
}

/** Synthetic 120 BPM fixture from the existing native classifier check; never microphone audio. */
async function musicFixture() {
  const rate = 16000, samples = rate * 12, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const t = index / rate, chord = [220, 261.6256, 329.6276][Math.floor(t / 2) % 3];
    const kick = Math.sin(2 * Math.PI * 80 * t) * Math.exp(-(t % 0.5) * 40) * 0.55;
    const note = Math.sin(2 * Math.PI * chord * t) * 0.09 + Math.sin(2 * Math.PI * chord * 1.5 * t) * 0.06;
    const hat = Math.sin(2 * Math.PI * 3100 * t) * Math.exp(-(t % 0.25) * 90) * 0.11;
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, kick + note + hat)) * 32767), 44 + index * 2);
  }
  const path = join(temporary, "test-rhythm.wav"); await writeFile(path, wav); return path;
}

const deadline = setTimeout(() => { output?.kill(); host?.close(); }, requestPermissions ? 180_000 : 60_000);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { canceled = true; output?.kill(); host?.close(); });
try {
  await start(false);
  report.permissions = await request("dictation-status", "dictation-status");
  assert(!report.permissions.recording, "Preflight opened the microphone");
  await close();
  if (acoustic) {
    assert(requestPermissions || report.permissions.microphonePermission === "authorized" && report.permissions.speechPermission === "authorized"
      && report.permissions.available, "Existing microphone and speech permissions are required; no prompts were requested");
    await start(true);
    let wake;
    for (let attempt = 0; attempt < (requestPermissions ? 300 : 30); attempt++) {
      wake = await request("wake-status", "wake-status"); if (wake.listening) break; await delay(200);
    }
    report.permissions = await request("dictation-status", "dictation-status");
    assert(wake.listening, "Keyword capture did not start");
    const playing = testMusic ? play("/usr/bin/afplay", [await musicFixture()]) : delay(500);
    let playingDone = false; void playing.finally(() => { playingDone = true; }).catch(() => {});
    while (!playingDone) {
      const music = await request("music-status", "music-status");
      report.musicListening ||= music.listening; report.musicAudible ||= music.audible;
      report.musicConfidence = Math.max(report.musicConfidence ?? 0, music.confidence ?? 0);
      report.musicClassifications ??= {};
      report.musicClassifications[music.classification] = Math.max(report.musicClassifications[music.classification] ?? 0, music.confidence ?? 0);
      report.musicWindows ??= [];
      const previous = report.musicWindows.at(-1);
      if (!previous || previous.classification !== music.classification || previous.confidence !== music.confidence) {
        report.musicWindows.push({ classification: music.classification, confidence: music.confidence, gate: music.gateAllowance });
      }
      report.measuredTempo = Math.max(report.measuredTempo ?? 0, music.tempo ?? 0);
      report.musicGate = Math.max(report.musicGate ?? 0, music.gateAllowance ?? 0);
      report.beatConfidence = Math.max(report.beatConfidence ?? 0, music.beatConfidence ?? 0);
      report.analysisLagMs = Math.max(report.analysisLagMs ?? 0, music.analysisLagMs ?? 0);
      if (music.strength > report.musicStrength) { report.musicStrength = music.strength; report.tempo = music.tempo; }
      await delay(250);
    }
    await playing; await delay(1000);
    await play("/usr/bin/say", ["-v", "Milena", "Опен код"]); await delay(500);
    await play("/usr/bin/say", ["-v", "Milena", "Проверь тесты"]); await delay(1700);
    await play("/usr/bin/say", ["-v", "Milena", "Отправить"]);
    for (let attempt = 0; attempt < 30 && !report.submitted; attempt++) await delay(200);
    report.finalState = await request("dictation-status", "dictation-status");
    if (!report.submitted && report.finalState.active) {
      host.send({ type: "dictation-stop" }); await delay(2500);
      report.requiredManualFinish = report.submitted;
    }
    if (testMusic) assert(report.musicListening && report.musicStrength > 0.05, "No microphone music reaction observed");
    assert(report.woke && report.dictationStarted && report.submitted && report.keywordRemoved, "Acoustic wake and explicit send did not match");
    assert(!report.requiredManualFinish, "Send was recognized only after manually ending capture");
    assert(!report.backgroundDeliveredText, "Passive conversation escaped as a draft");
  }
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.message; process.exitCode = 1;
} finally {
  clearTimeout(deadline); output?.kill();
  if (waiting) { clearTimeout(waiting.timer); waiting = undefined; }
  await close(); await rm(temporary, { recursive: true, force: true });
  await writeFile(join(root, ".local/wake-microphone-smoke.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
