import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalTts } from "../packages/companions/dist/local-tts.js";
import { SpeechRouter } from "../packages/companions/dist/speech-router.js";
import { configSchema } from "../packages/companions/dist/config.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, ".local/tts/voice-previews");
const config = configSchema.parse({ tts: { engine: "local" } });
const samples = [
  { name: "lead", role: "coordinator", text: "Я соберу план и распределю задачи." },
  { name: "code", role: "developer", text: "Проверю код и запущу тесты." },
  { name: "research", role: "researcher", text: "Найду документацию и проверю источники." },
  { name: "review", role: "reviewer", text: "Проверю изменения и отмечу ошибки." },
];
await mkdir(directory, { recursive: true });
let router, timer, rejectRun;
const tts = new LocalTts({ log: () => rejectRun?.(new Error("Local speech worker failed")) });
try {
  await new Promise((resolve, reject) => {
    rejectRun = reject; let completed = 0;
    timer = setTimeout(() => reject(new Error("Voice preview generation timed out")), 240_000);
    router = new SpeechRouter(config, tts, event => {
      if (event.type !== "play-audio") return;
      const sample = samples.find(item => item.name === event.characterId);
      if (!sample) { reject(new Error("Unknown preview role")); return; }
      void copyFile(event.path, join(directory, `${sample.name}.wav`)).then(() => {
        router.receive({ type: "audio-finished", id: event.audioId, phase: "end" });
        console.log(`Prepared ${sample.name}: ${config.tts.voices[sample.role]}`);
        if (++completed === samples.length) resolve();
      }, reject);
    }, () => reject(new Error("Local synthesis fell back during preview generation")));
    for (const sample of samples) router.event({ type: "speak", characterId: sample.name, role: sample.role, text: sample.text });
  });
  // The production worker writes canonical mono PCM16 WAV; concatenate its
  // samples with a short separator, without resampling or changing the voices.
  const files = await Promise.all(samples.map(sample => readFile(join(directory, `${sample.name}.wav`))));
  for (const file of files) {
    if (file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE" ||
        file.toString("ascii", 12, 16) !== "fmt " || file.readUInt32LE(16) !== 16 ||
        file.readUInt16LE(20) !== 1 || file.readUInt16LE(22) !== 1 || file.readUInt16LE(34) !== 16 ||
        file.toString("ascii", 36, 40) !== "data" || file.readUInt32LE(24) !== files[0].readUInt32LE(24)) {
      throw new Error("Unexpected preview WAV format");
    }
  }
  const rate = files[0].readUInt32LE(24), gapSeconds = 0.22;
  const parts = files.flatMap((file, index) => [file.subarray(44), ...(index + 1 < files.length ? [Buffer.alloc(Math.round(rate * gapSeconds) * 2)] : [])]);
  const pcm = Buffer.concat(parts), header = Buffer.from(files[0].subarray(0, 44));
  header.writeUInt32LE(pcm.length + 36, 4); header.writeUInt32LE(pcm.length, 40);
  await writeFile(join(directory, "preview.wav"), Buffer.concat([header, pcm]));
  await writeFile(join(directory, "samples.json"), JSON.stringify({ createdAt: new Date().toISOString(),
    model: JSON.parse(await readFile(join(root, "packages/companions/tts/model.json"), "utf8")),
    note: "Existing local Qwen voices through production role profiles; no voice training or microphone recording.",
    sampleRate: rate, gapSeconds, combinedSeconds: pcm.length / (rate * 2),
    samples: samples.map((sample, index) => ({ ...sample, voice: config.tts.voices[sample.role],
      durationSeconds: (files[index].length - 44) / (rate * 2), file: `${sample.name}.wav` })),
  }, null, 2) + "\n");
  console.log(`Saved ${join(directory, "preview.wav")}`);
} finally { clearTimeout(timer); router?.dispose(); tts.dispose(); }
