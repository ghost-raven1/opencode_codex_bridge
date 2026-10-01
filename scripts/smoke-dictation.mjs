import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startNativeHost } from "../packages/companions/dist/native-host.js";

// Explicit acoustic check: plays one known phrase and retains neither audio nor recognized text.
const binary = fileURLToPath(new URL("../packages/companions/native/CodexBridge Companions.app/Contents/MacOS/Companions", import.meta.url));
let host, recording = false, matched = false, ended = false, say, timeout, acoustic;
const send = event => { try { host?.send(event); } catch {} };
const finish = () => {
  if (ended) return;
  ended = true; clearTimeout(timeout); say?.kill("SIGTERM");
  send({ type: "dictation-cancel" }); send({ type: "dictation-status" });
  setTimeout(() => {
    host?.close(); process.exitCode = matched ? 0 : 1;
    console.log(JSON.stringify({ recordingStarted: recording, phraseMatched: matched, acoustic }));
  }, 300);
};
host = await startNativeHost(binary, ["--config", JSON.stringify({ showOnStart: false, dictation: true,
  speech: "off", language: "ru-RU" })], event => {
  if (event.type === "dictation-status") {
    console.log(JSON.stringify(event));
    if (!event.enabled) { console.error("Dictation is disabled; enable it explicitly in the companion menu before testing."); finish(); }
  }
  if (event.type === "dictation" && event.active && !recording) {
    recording = true;
    setTimeout(() => {
      if (ended) return;
      say = spawn("/usr/bin/say", ["-v", "Milena", "Проверка микрофона. Один, два, три."], { stdio: "ignore" });
      say.on("error", finish);
      say.on("exit", () => setTimeout(() => { if (!ended) send({ type: "dictation-stop" }); }, 800));
    }, 1500);
  }
  if (event.type === "transcript") {
    const normalized = String(event.text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    matched = /проверка\s+микрофона/u.test(normalized);
    // Only boolean hints about the known service phrase enter diagnostics, never microphone text.
    acoustic = { nonempty: !!normalized, heardCheck: /проверка/u.test(normalized), heardMicrophone: /микрофон/u.test(normalized) };
    finish();
  }
  if (event.type === "error") { console.error(event.message); finish(); }
  if (event.type === "closed" && !ended) finish();
}, message => console.error(message));
send({ type: "dictation-status" }); send({ type: "dictation-start" });
console.log("Confirm the macOS microphone and speech-recognition prompts. Use speakers for this acoustic check.");
timeout = setTimeout(() => { console.error("No matching transcript before timeout"); finish(); }, 120_000);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, finish);
