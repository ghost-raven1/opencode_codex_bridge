"""Keep model downloads, generated speech, and library caches inside this checkout."""
import json
import os
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parents[2]
LOCAL = ROOT / ".local" / "tts"
AUDIO = LOCAL / "audio"
MODEL = json.loads((SOURCE / "model.json").read_text())
MODEL_PATH = LOCAL / "models" / MODEL["directory"]


def configure_environment(offline=True):
    paths = {
        "HF_HOME": LOCAL / "cache" / "huggingface",
        "HF_HUB_CACHE": LOCAL / "cache" / "huggingface" / "hub",
        "HF_XET_CACHE": LOCAL / "cache" / "huggingface" / "xet",
        "XDG_CACHE_HOME": LOCAL / "cache",
        "PIP_CACHE_DIR": LOCAL / "cache" / "pip",
        "TMPDIR": LOCAL / "tmp",
    }
    for name, path in paths.items():
        path.mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(path)
    AUDIO.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    if offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"


def write_wav(path, audio, sample_rate):
    """Write mono PCM16 without requiring another audio playback or codec package."""
    import wave
    import numpy as np

    samples = np.asarray(audio).reshape(-1)
    if samples.size == 0 or not np.isfinite(samples).all():
        raise ValueError("invalid-audio")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
    return samples.size / sample_rate
