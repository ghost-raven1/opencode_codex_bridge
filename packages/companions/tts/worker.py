"""Persistent offline Qwen speech worker. Stdout contains only bounded JSONL responses."""
import json
import os
from pathlib import Path
import sys
import threading
import time
import uuid

sys.pycache_prefix = str(Path(__file__).resolve().parents[3] / ".local/tts/cache/pycache")
from local_paths import AUDIO, MODEL, MODEL_PATH, LOCAL, SOURCE, configure_environment, write_wav
from speech_budget import SpeechLimitError, check_generation, speech_budget
from voice_profiles import VoiceModels, read_profiles
from stream_control import StreamCancelled, StreamControl
from stream_synthesis import synthesize_stream

REFERENCES = SOURCE.parent / "assets/expansion/voices"
PROFILES = read_profiles(REFERENCES)

# Preserve a private protocol stream before redirecting Python and native-library stdout.
protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8")
protocol_lock = threading.Lock()
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
configure_environment()
os.chdir(AUDIO)


def send(event):
    with protocol_lock:
        protocol.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n")
        protocol.flush()


def error(request_id, code, message):
    send({"type": "error", "id": request_id, "code": code, "message": message})


def validate(value):
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    request_id = value.get("id")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
        raise ValueError("id must contain 1–128 characters")
    text = value.get("text")
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 2000:
        raise ValueError("text must contain 1–2000 characters")
    choices = {name.lower(): name for name in [*MODEL["voices"], *PROFILES["profiles"]]}
    voice = value.get("voice")
    if not isinstance(voice, str) or voice.lower() not in choices:
        raise ValueError("voice must match an installed local voice profile")
    instructions = value.get("instructions")
    if instructions is not None and (not isinstance(instructions, str) or len(instructions) > 500):
        raise ValueError("instructions must contain at most 500 characters")
    if value.get("stream") is not None and type(value["stream"]) is not bool:
        raise ValueError("stream must be a boolean")
    return request_id, text.strip(), choices[voice.lower()], instructions


def main():
    # Playback owners delete files when done; recover only abandoned worker-owned output.
    cutoff = time.time() - 24 * 60 * 60
    for path in AUDIO.glob("speech-*.wav"):
        if path.is_file() and path.stat().st_mtime < cutoff:
            path.unlink(missing_ok=True)
    if not (MODEL_PATH / "model.safetensors").is_file():
        error(None, "model-missing", "Run node scripts/setup-local-tts.mjs before enabling local speech")
        return 1
    started = time.perf_counter()
    try:
        import mlx.core as mx
        from mlx_audio.tts.utils import load_model

        models = VoiceModels(MODEL_PATH, LOCAL / "models", REFERENCES, PROFILES, load_model, mx.clear_cache)
    except Exception as failure:
        print(f"Local TTS initialization failed ({type(failure).__name__})", file=sys.stderr)
        error(None, "model-load-failed", "Local speech model could not be loaded")
        return 1
    send({"type": "ready", "model": MODEL["id"], "revision": MODEL["revision"],
          "voices": [*MODEL["voices"], *PROFILES["profiles"]], "deferredModelLoad": True,
          "startupSeconds": round(time.perf_counter() - started, 3)})
    control = StreamControl(sys.stdin.buffer, send)
    control.start()
    while (value := control.take()) is not None:
        request_id = value["id"]
        try:
            request_id, text, voice, instructions = validate(value)
        except (ValueError, UnicodeError):
            error(request_id, "invalid-request", "Expected id, text (1–2000 characters), a supported voice, and optional instructions (up to 500 characters)")
            control.finish(request_id)
            continue
        path = AUDIO / f"speech-{uuid.uuid4().hex}.wav"
        started = time.perf_counter()
        try:
            mx.reset_peak_memory()
            control.check(request_id)
            if value.get("stream") is True:
                synthesize_stream(request_id, text, voice, instructions, MODEL["language"], models, mx,
                                  control, AUDIO, write_wav, send)
                continue
            max_duration, max_tokens = speech_budget(text)
            results, sample_rate = models.generate(voice, text, MODEL["language"], instructions, max_tokens)
            duration = sum(result.audio.size for result in results) / sample_rate
            check_generation(sum(result.token_count for result in results), max_tokens, duration, max_duration)
            audio = mx.concatenate([result.audio.reshape(-1) for result in results])
            mx.eval(audio)
            duration = write_wav(path, audio, sample_rate)
            control.check(request_id)
            send({"type": "audio", "id": request_id, "path": str(path), "duration": duration,
                  "sampleRate": sample_rate, "elapsedSeconds": round(time.perf_counter() - started, 3),
                  "peakMemoryBytes": mx.get_peak_memory()})
        except BrokenPipeError:
            path.unlink(missing_ok=True)
            return 0
        except StreamCancelled:
            path.unlink(missing_ok=True)
            send({"type": "stream-cancelled", "id": request_id})
        except SpeechLimitError:
            path.unlink(missing_ok=True)
            error(request_id, "speech-limit", "Local speech exceeded its generation budget")
        except Exception as failure:
            path.unlink(missing_ok=True)
            print(f"Local TTS generation failed ({type(failure).__name__})", file=sys.stderr)
            error(request_id, "generation-failed", "Local speech generation failed; retry with a shorter phrase")
        finally:
            control.finish(request_id)
            mx.clear_cache()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BrokenPipeError, KeyboardInterrupt):
        raise SystemExit(0)
