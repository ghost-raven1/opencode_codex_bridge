import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const source = fileURLToPath(new URL("../packages/companions/tts/", import.meta.url));

describe("Qwen streaming adapter", () => {
  it("keeps both voice families lazy, supplies stream settings, resets decoder, and preserves legacy output", async () => {
    const { stdout } = await promisify(execFile)("python3", ["-B", "-c", `
import json, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
from voice_profiles import VoiceModels
calls, evaluations, resets, loads = [], [], [], []
class Model:
    tokenizer = object()
    sample_rate = 24000
    def __init__(self, path):
        self.path = path
        self.speech_tokenizer = SimpleNamespace(decoder=SimpleNamespace(reset_streaming_state=lambda: resets.append(path)))
    def results(self):
        evaluations.append(self.path)
        yield SimpleNamespace(audio=None)
    def generate(self, **kwargs):
        calls.append({"family": "reference", **kwargs})
        return self.results()
    def generate_custom_voice(self, **kwargs):
        calls.append({"family": "custom", **kwargs})
        return self.results()
def load(path):
    loads.append(path)
    return Model(path)
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    for directory in ["custom", "base", "references"]:
        (root / directory).mkdir()
    for directory in ["custom", "base"]:
        (root / directory / "model.safetensors").touch()
    (root / "references" / "test.wav").touch()
    spec = {"model": {"directory": "base"}, "profiles": {"tester-local": {"refAudio": "test.wav", "refText": "Sample"}}}
    models = VoiceModels(root / "custom", root, root / "references", spec, load, lambda: None)
    lazy = []
    for voice in ["Serena", "tester-local"]:
        before = len(evaluations)
        generator, rate = models.generate(voice, "Public", "Russian", "steady", 188, stream=True)
        lazy.append(len(evaluations) == before and not isinstance(generator, list))
        assert rate == 24000
        next(generator)
        generator.close()
        models.reset_stream()
    legacy, _ = models.generate("Serena", "Public", "Russian", None, 188)
    print(json.dumps({"lazy": lazy, "calls": [{key: call.get(key) for key in ["family", "stream", "streaming_interval", "temperature", "max_tokens"]} for call in calls], "resets": len(resets), "loads": len(loads), "legacyLength": len(legacy)}))
`, source], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(JSON.parse(stdout)).toEqual({
      lazy: [true, true],
      calls: [
        { family: "custom", stream: true, streaming_interval: 2, temperature: 0.7, max_tokens: 188 },
        { family: "reference", stream: true, streaming_interval: 2, temperature: 0.6, max_tokens: 188 },
        { family: "custom", stream: null, streaming_interval: null, temperature: 0.7, max_tokens: 188 },
      ],
      resets: 2, loads: 3, legacyLength: 1,
    });
  });

  it("rejects credit spoofing and oversized input while the control reader remains usable", async () => {
    const { stdout } = await promisify(execFile)("python3", ["-B", "-c", `
import io, json, sys
sys.path.insert(0, sys.argv[1])
from stream_control import StreamControl
events = []
control = StreamControl(io.BytesIO(b"x" * (64 * 1024 + 5) + b"\\n" + b'{"type":"consume","id":"a","index":false}\\n' + b'{"type":"cancel","id":"a"}\\n'), events.append)
control.accept({"id": "a", "text": "Public"})
control.reserve("a")
control.publish("a", 0, 2)
control.read()
print(json.dumps({"errors": len(events), "credit": sum(control.credits.values()), "cancelled": "a" in control.cancelled, "closed": control.closed}))
`, source], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(JSON.parse(stdout)).toEqual({ errors: 2, credit: 2, cancelled: true, closed: true });
  });
});
