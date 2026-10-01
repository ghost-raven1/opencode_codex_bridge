"""Persistent offline Qwen speech worker. Stdout contains only bounded JSONL responses."""
import json
import os
from pathlib import Path
import sys
import time
import uuid

sys.pycache_prefix = str(Path(__file__).resolve().parents[3] / ".local/tts/cache/pycache")
from local_paths import AUDIO, MODEL, MODEL_PATH, configure_environment, write_wav

# Preserve a private protocol stream before redirecting Python and native-library stdout.
protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8")
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
configure_environment()
os.chdir(AUDIO)


def send(event):
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
    choices = {name.lower(): name for name in MODEL["voices"]}
    voice = value.get("voice")
    if not isinstance(voice, str) or voice.lower() not in choices:
        raise ValueError("voice must be Serena, Vivian, Sohee, or Ono_Anna")
    instructions = value.get("instructions")
    if instructions is not None and (not isinstance(instructions, str) or len(instructions) > 500):
        raise ValueError("instructions must contain at most 500 characters")
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

        model = load_model(str(MODEL_PATH))
        if model.tokenizer is None or model.speech_tokenizer is None:
            raise RuntimeError("incomplete-model")
    except Exception as failure:
        print(f"Local TTS initialization failed ({type(failure).__name__})", file=sys.stderr)
        error(None, "model-load-failed", "Local speech model could not be loaded")
        return 1
    send({"type": "ready", "model": MODEL["id"], "revision": MODEL["revision"],
          "voices": MODEL["voices"], "sampleRate": model.sample_rate,
          "loadSeconds": round(time.perf_counter() - started, 3)})
    while True:
        # Limit bytes before parsing so an accidental unbounded stdin line cannot exhaust memory.
        line = sys.stdin.buffer.readline(64 * 1024 + 1)
        if not line:
            return 0
        if len(line) > 64 * 1024:
            while line and not line.endswith(b"\n"):
                line = sys.stdin.buffer.readline(64 * 1024 + 1)
            error(None, "invalid-request", "Request exceeds 64 KiB")
            continue
        request_id = None
        try:
            value = json.loads(line)
            if isinstance(value, dict) and isinstance(value.get("id"), str) and len(value["id"]) <= 128:
                request_id = value["id"]
            request_id, text, voice, instructions = validate(value)
        except (ValueError, UnicodeError):
            error(request_id, "invalid-request", "Expected id, text (1–2000 characters), a supported voice, and optional instructions (up to 500 characters)")
            continue
        path = AUDIO / f"speech-{uuid.uuid4().hex}.wav"
        started = time.perf_counter()
        try:
            mx.reset_peak_memory()
            results = list(model.generate_custom_voice(text=text, speaker=voice, language=MODEL["language"],
                instruct=instructions, temperature=0.7, max_tokens=2048, verbose=False))
            if not results or sum(result.token_count for result in results) >= 2048:
                raise RuntimeError("speech-limit")
            audio = mx.concatenate([result.audio.reshape(-1) for result in results])
            mx.eval(audio)
            duration = write_wav(path, audio, model.sample_rate)
            send({"type": "audio", "id": request_id, "path": str(path), "duration": duration,
                  "sampleRate": model.sample_rate, "elapsedSeconds": round(time.perf_counter() - started, 3),
                  "peakMemoryBytes": mx.get_peak_memory()})
        except BrokenPipeError:
            path.unlink(missing_ok=True)
            return 0
        except Exception as failure:
            path.unlink(missing_ok=True)
            print(f"Local TTS generation failed ({type(failure).__name__})", file=sys.stderr)
            error(request_id, "generation-failed", "Local speech generation failed; retry with a shorter phrase")
        finally:
            mx.clear_cache()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BrokenPipeError, KeyboardInterrupt):
        raise SystemExit(0)
