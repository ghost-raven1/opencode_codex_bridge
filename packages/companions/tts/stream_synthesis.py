"""Incremental Qwen output with a final event based on iterator exhaustion."""
import uuid

from speech_budget import check_generation, speech_budget
from stream_control import CHUNK_RESERVATION_SECONDS


def synthesize_stream(request_id, text, voice, instructions, language, models, mx, control, directory, write_wav, send):
    """Files transfer to the playback owner only after their protocol event is sent."""
    results = None
    current_path = None
    send({"type": "stream-start", "id": request_id})
    try:
        maximum_duration, maximum_tokens = speech_budget(text)
        control.check(request_id)
        results, sample_rate = models.generate(voice, text, language, instructions, maximum_tokens, stream=True)
        iterator = iter(results)
        duration = 0.0
        tokens = 0
        index = 0
        while True:
            control.reserve(request_id)
            try:
                result = next(iterator)
            except StopIteration:
                break
            control.check(request_id)
            audio = result.audio.reshape(-1)
            mx.eval(audio)
            portion_duration = audio.size / sample_rate
            # 25 Qwen tokens at 12.5 Hz yield at most two seconds. Do not accept a
            # changed library contract that silently defeats global buffering limits.
            if not 0 < portion_duration <= CHUNK_RESERVATION_SECONDS + 1e-9:
                raise ValueError("invalid-stream-duration")
            duration += portion_duration
            tokens += result.token_count
            check_generation(tokens, maximum_tokens, duration, maximum_duration)
            current_path = directory / f"speech-{uuid.uuid4().hex}.wav"
            portion_duration = write_wav(current_path, audio, sample_rate)
            control.publish(request_id, index, portion_duration)
            send({"type": "audio-chunk", "id": request_id, "index": index, "path": str(current_path),
                  "duration": portion_duration, "sampleRate": sample_rate})
            current_path = None
            index += 1
        check_generation(tokens, maximum_tokens, duration, maximum_duration)
        send({"type": "stream-end", "id": request_id, "chunks": index})
    finally:
        if current_path is not None:
            current_path.unlink(missing_ok=True)
        if results is not None and hasattr(results, "close"):
            results.close()
        models.reset_stream()
