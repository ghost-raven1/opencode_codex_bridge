import { fileURLToPath } from "node:url";
import { startNativeHost } from "../packages/companions/dist/native-host.js";
import { LocalTts } from "../packages/companions/dist/local-tts.js";
import { SpeechRouter } from "../packages/companions/dist/speech-router.js";
import { configSchema } from "../packages/companions/dist/config.js";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Requires Apple Silicon macOS");
const binary = fileURLToPath(new URL("../packages/companions/native/CodexBridge Companions.app/Contents/MacOS/Companions", import.meta.url));
const config = configSchema.parse({ enabled: true, showOnStart: false, dictation: false, tts: { engine: "local" } });
let router, host, timer, ended = false, played = 0;
const problems = [];
const log = message => { problems.push(message); console.error(message); };
const finish = () => {
  if (ended) return;
  ended = true; clearTimeout(timer); router?.dispose(); host?.close();
  console.log(JSON.stringify({ playedVoices: played, expectedVoices: 4, passed: played === 4 && !problems.length }));
  if (played !== 4 || problems.length) process.exitCode = 1;
};
host = await startNativeHost(binary, ["--config", JSON.stringify(config)], event => {
  router?.receive(event);
  if (event.type === "audio-finished") {
    console.log(JSON.stringify({ playback: event.phase }));
    if (event.phase === "end") played++;
    else log("Playback did not complete");
    if (played === 4 || problems.length) finish();
  }
  if (event.type === "closed" && !ended) { log("Native companion closed during playback"); finish(); }
}, log);
const tts = new LocalTts({ log });
router = new SpeechRouter(config, {
  async synthesize(request) {
    const start = Date.now();
    const audio = await tts.synthesize(request);
    console.log(JSON.stringify({ voice: request.voice, audioSeconds: audio.duration, generationSeconds: (Date.now() - start) / 1000 }));
    return audio;
  },
  dispose: () => tts.dispose(),
}, event => host.send(event), log);
timer = setTimeout(() => { log("Voice playback smoke timed out"); finish(); }, 150_000);
router.receive({ type: "test-voices" });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, finish);
