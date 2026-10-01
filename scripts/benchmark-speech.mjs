import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalTts } from "../packages/companions/dist/local-tts.js";
import { SpeechRouter } from "../packages/companions/dist/speech-router.js";
import { startNativeHost } from "../packages/companions/dist/native-host.js";
import { configSchema } from "../packages/companions/dist/config.js";

/** Compare fixed public samples using actual native callbacks; never record or retain audio. */
const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2] ?? "--mode=both";
if (process.argv.length > 3 || !["--mode=both", "--mode=serial", "--mode=prefetch"].includes(mode)) {
  throw new Error("Usage: node scripts/benchmark-speech.mjs [--mode=both|serial|prefetch]");
}
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Requires Apple Silicon macOS");
const samples = [
  ["coordinator", "Serena", "Warm and confident.", "Я веду задачу и собираю результаты команды. Сейчас проверим работу голосовой очереди."],
  ["developer", "Vivian", "Bright, energetic and focused.", "Я пишу код и проверяю тесты. Следующая фраза готовится заранее, пока звучит предыдущая."],
  ["researcher", "Sohee", "Gentle, thoughtful and measured.", "Я изучаю материалы и проверяю источники. Локальный синтез не отправляет текст в сеть."],
  ["reviewer", "Ono_Anna", "Calm, firm and deliberate.", "Я проверяю изменения и ищу ошибки. Отмена должна остановить всю устаревшую очередь."],
];
const config = configSchema.parse({ enabled: true, showOnStart: false, dictation: false, tts: { engine: "local" } });
const model = JSON.parse(await readFile(join(root, "packages/companions/tts/model.json"), "utf8"));
const report = { createdAt: new Date().toISOString(), model: model.id, revision: model.revision,
  measurement: "Native AVAudioPlayer speech-start and audio-finished callbacks; not an acoustic microphone measurement. Fixed samples; stochastic WAV duration can vary.",
  startupAndWarmupSeconds: 0, rounds: [], passed: false };
let host, router, round, activeId, lastEnd, resolvePlayback, resolveRound, rejectRound, finished = false;
const records = new Map(), pendingAudio = new Set();
const tts = new LocalTts({ log: () => rejectRound?.(new Error("Local speech worker failed")) });
const fail = message => rejectRound?.(new Error(message));
const seconds = milliseconds => Number((milliseconds / 1000).toFixed(4));

async function synthesize(request) {
  const started = performance.now();
  const audio = await tts.synthesize(request);
  pendingAudio.add(audio.path);
  records.set(request.id, { voice: request.voice, audioSeconds: audio.duration,
    generationSeconds: seconds(performance.now() - started) });
  return audio;
}

async function removeAudio(path) {
  pendingAudio.delete(path);
  await unlink(path).catch(() => undefined);
}

function send(event) {
  if (event.type === "play-audio") {
    activeId = event.audioId;
    const entry = records.get(activeId);
    if (entry) { entry.role = event.role; entry.sent = performance.now(); }
  }
  host.send(event);
}

function receive(event) {
  if (event.type === "speech" && event.phase === "start" && activeId) {
    const entry = records.get(activeId);
    if (entry) {
      entry.start = performance.now();
      entry.gapAfterPreviousEndSeconds = lastEnd === undefined ? null : seconds(entry.start - lastEnd);
    }
  }
  if (event.type === "audio-finished") {
    const entry = records.get(event.id);
    if (entry) {
      lastEnd = performance.now();
      if (event.phase !== "end" || entry.start === undefined) { fail("Native playback did not complete"); return; }
      const result = { voice: entry.voice, role: entry.role, audioSeconds: entry.audioSeconds,
        generationSeconds: entry.generationSeconds, gapAfterPreviousEndSeconds: entry.gapAfterPreviousEndSeconds,
        nativeDispatchSeconds: seconds(entry.start - entry.sent), nativePlaybackSeconds: seconds(lastEnd - entry.start) };
      round.items.push(result); records.delete(event.id); activeId = undefined;
      console.log(JSON.stringify({ mode: round.mode, ...result }));
      resolvePlayback?.(); resolvePlayback = undefined;
    }
  }
  router?.receive(event);
  if (round?.mode === "prefetch" && round.items.length === 4) resolveRound?.();
  if (event.type === "closed" && !finished) fail("Native companion closed during benchmark");
}

async function measure(selected) {
  round = { mode: selected, items: [] }; report.rounds.push(round); lastEnd = undefined;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Speech benchmark timed out")), 240_000);
    rejectRound = error => { clearTimeout(timeout); reject(error); };
    const done = () => { clearTimeout(timeout); resolve(); };
    resolveRound = done;
    if (selected === "serial") {
      void (async () => {
        for (const [index, [role, voice, instructions, text]] of samples.entries()) {
          const id = randomUUID(), audio = await synthesize({ id, text, voice, instructions });
          await new Promise(resolve => {
            resolvePlayback = resolve;
            send({ type: "play-audio", audioId: id, characterId: `benchmark-${index}`, role, text, path: audio.path });
          });
          await removeAudio(audio.path);
        }
        done();
      })().catch(error => { clearTimeout(timeout); reject(error); });
    } else {
      router = new SpeechRouter(config, { synthesize, dispose() {} }, send,
        () => { clearTimeout(timeout); reject(new Error("Local speech fell back during benchmark")); }, removeAudio);
      for (const [index, [role, voice, , text]] of samples.entries()) {
        router.event({ type: "speak", characterId: `benchmark-${index}`, role, voice, text });
      }
    }
  });
  router?.dispose(); router = undefined; rejectRound = undefined; resolveRound = undefined;
  const gaps = round.items.slice(1).map(item => item.gapAfterPreviousEndSeconds);
  round.meanGapSeconds = Number((gaps.reduce((sum, value) => sum + value, 0) / gaps.length).toFixed(4));
}

try {
  const binary = join(root, "packages/companions/native/CodexBridge Companions.app/Contents/MacOS/Companions");
  // No atlas, demo, or microphone command: this instance only plays fixed test speech.
  host = await startNativeHost(binary, ["--config", JSON.stringify(config)], receive, () => fail("Native transport failed"));
  const started = performance.now();
  const warmup = await tts.synthesize({ id: randomUUID(), text: "Проверка локального синтезатора.", voice: "Serena" });
  report.startupAndWarmupSeconds = seconds(performance.now() - started);
  await removeAudio(warmup.path);
  for (const selected of mode === "--mode=both" ? ["serial", "prefetch"] : [mode.slice(7)]) await measure(selected);
  report.passed = report.rounds.every(round => round.items.length === 4 && new Set(round.items.map(item => item.voice)).size === 4);
  const directory = join(root, ".local/tts/benchmarks"); await mkdir(directory, { recursive: true });
  const path = join(directory, "native-queue.json"); await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed, report: path }));
  if (!report.passed) process.exitCode = 1;
} finally {
  finished = true; router?.dispose(); tts.dispose(); host?.close();
  await Promise.all([...pendingAudio].map(removeAudio));
}
