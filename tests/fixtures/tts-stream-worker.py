"""Exercise the production streaming controller without importing MLX or a GPU model."""
import json
import os
from pathlib import Path
import sys
import threading
import time
import uuid
import wave

sys.path.insert(0, TTS_SOURCE)
from stream_control import StreamCancelled, StreamControl
from stream_synthesis import synthesize_stream

directory = Path(os.environ["CODEXBRIDGE_TTS_AUDIO_DIR"])
log_path = Path(FIXTURE_LOG)
lock = threading.Lock()
mode = "normal"


def log(event):
    with log_path.open("a") as output:
        output.write(event + "\n")


def send(event):
    if event["type"] == "audio-chunk":
        if mode == "reorder":
            event = {**event, "index": 1}
        if mode == "bad-pcm":
            Path(event["path"]).write_bytes(bytes(100))
        if mode == "bad-duration":
            event = {**event, "duration": event["duration"] / 2}
    with lock:
        print(json.dumps(event), flush=True)
        if mode == "duplicate" and event["type"] == "audio-chunk":
            print(json.dumps(event), flush=True)


class Audio:
    def __init__(self, seconds):
        self.size = round(seconds * 24000)

    def reshape(self, _shape):
        return self


class Result:
    def __init__(self, duration):
        self.audio = Audio(duration)
        self.token_count = max(1, int(duration * 12.5))
        # No is_final_chunk: exhaustion remains the authoritative end signal.


class Models:
    def generate(self, voice, _text, _language, _instructions, _budget, stream=False):
        assert stream is True

        def iterator():
            durations = [2] * 8 if voice in ("flow", "budget") else [2, 2, 0.32]
            if voice == "edge":
                durations = [2.04, 0.32]
            if voice == "hang":
                time.sleep(30)
            try:
                for index, duration in enumerate(durations):
                    if voice == "crash" and index == 1:
                        # Die only after the test confirms that the queue owns the first WAV.
                        while not (log_path.parent / "crash-now").exists():
                            time.sleep(0.01)
                        os._exit(3)
                    if voice == "cancel":
                        time.sleep(0.12)
                    yield Result(duration)
            finally:
                log("closed:" + voice)
        return iterator(), 24000

    def reset_stream(self):
        log("reset:" + mode)


class MX:
    @staticmethod
    def eval(_value):
        pass


def write_wav(path, audio, rate):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(bytes(audio.size * 2))
    return audio.size / rate


log("launch")
send({"type": "ready"})
control = StreamControl(sys.stdin.buffer, send)
control.start()
while (request := control.take()) is not None:
    mode = request["voice"]
    request_id = request["id"]
    try:
        if mode == "overflow":
            send({"type": "stream-start", "id": request_id})
            for index in range(7):
                path = directory / f"speech-{uuid.uuid4().hex}.wav"
                write_wav(path, Audio(2), 24000)
                send({"type": "audio-chunk", "id": request_id, "index": index, "path": str(path), "duration": 2, "sampleRate": 24000})
            send({"type": "stream-end", "id": request_id, "chunks": 7})
        else:
            synthesize_stream(request_id, request["text"], mode, None, "Russian", Models(), MX(), control, directory, write_wav, send)
            if mode == "late":
                time.sleep(0.05)
                path = directory / "speech-late.wav"
                write_wav(path, Audio(0.32), 24000)
                send({"type": "audio-chunk", "id": request_id, "index": 3, "path": str(path), "duration": 0.32, "sampleRate": 24000})
    except StreamCancelled:
        send({"type": "stream-cancelled", "id": request_id})
    except Exception:
        send({"type": "error", "id": request_id, "code": "generation-failed"})
    finally:
        control.finish(request_id)
