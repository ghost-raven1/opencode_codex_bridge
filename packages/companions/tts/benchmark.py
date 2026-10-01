"""Generate four comparable Russian samples and measure this machine, without playback."""
import json
import resource
import sys
import time
from pathlib import Path

sys.pycache_prefix = str(Path(__file__).resolve().parents[3] / ".local/tts/cache/pycache")
from local_paths import AUDIO, LOCAL, MODEL, MODEL_PATH, configure_environment, write_wav

configure_environment()
started = time.perf_counter()
import mlx.core as mx
from mlx_audio.tts.utils import load_model

model = load_model(str(MODEL_PATH))
loaded = time.perf_counter()
print(json.dumps({"event": "loaded", "seconds": loaded - started,
                  "voices": model.get_supported_speakers()}), flush=True)
text = "Привет, Алексей. Задача в работе, скоро покажу результат."
report = {"model": MODEL, "loadSeconds": loaded - started, "text": text, "samples": []}
for index, voice in enumerate([*MODEL["voices"], MODEL["voices"][0]]):
    mx.random.seed(42)
    mx.reset_peak_memory()
    begin = time.perf_counter()
    results = list(model.generate_custom_voice(text=text, speaker=voice, language="Russian",
                                              max_tokens=384, temperature=0.7, verbose=False))
    audio = mx.concatenate([result.audio.reshape(-1) for result in results])
    mx.eval(audio)
    elapsed = time.perf_counter() - begin
    path = AUDIO / f"sample-{index + 1}-{voice.lower()}.wav"
    duration = write_wav(path, audio, results[0].sample_rate)
    sample = {"voice": voice, "path": str(path), "durationSeconds": duration,
              "generationSeconds": elapsed, "realTimeFactor": elapsed / duration,
              "processPeakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
              "mlxPeakBytes": mx.get_peak_memory(), "tokens": sum(result.token_count for result in results)}
    report["samples"].append(sample)
    (LOCAL / "benchmark.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(sample), flush=True)
