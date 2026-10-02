import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalTts } from "../packages/companions/dist/local-tts.js";

// Production JSONL worker, real pinned models and fixed synthetic references, one process.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, ".local/tts/production-voice-previews");
await mkdir(output, { recursive: true });
const report = { checkedAt: new Date().toISOString(), passed: false, samples: [],
  measurement: "Real production worker and PCM validation. No acoustic or subjective quality claim." };
const tts = new LocalTts();
try {
  for (const voice of ["designer-local", "devops-local", "tester-local", "Serena"]) {
    const started = Date.now();
    const audio = await tts.synthesize({ id: voice, voice, text: "Проверка завершена. Продолжаем работу." });
    const wav = await readFile(audio.path);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
    let peak = 0;
    for (let offset = 44; offset + 1 < wav.length; offset += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
    assert(peak > 100, `${voice} returned silent PCM`);
    assert(audio.duration > 0.25, `${voice} returned an empty phrase`);
    const path = join(output, `${voice}.wav`);
    await copyFile(audio.path, path); await unlink(audio.path);
    const sample = { voice, generationMs: Date.now() - started, audioSeconds: audio.duration, peak, path };
    report.samples.push(sample); console.log(JSON.stringify(sample));
  }
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  tts.dispose();
  await writeFile(join(root, ".local/specialist-voices-smoke.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed, samples: report.samples.length, error: report.error }));
}
