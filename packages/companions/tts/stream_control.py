"""Bound queued PCM while stdin remains responsive during MLX generation and playback."""
import json
import math
import queue
import threading

CHUNK_SECONDS = 2.0
# One 12.5 Hz token accommodates decoder boundary rounding before PCM exists.
CHUNK_RESERVATION_SECONDS = CHUNK_SECONDS + 1 / 12.5
MAX_BUFFERED_SECONDS = 12.0


class StreamCancelled(Exception):
    pass


class StreamControl:
    """The generation thread owns MLX; the input thread only changes control state."""
    def __init__(self, source, send):
        self.source = source
        self.send = send
        self.requests = queue.Queue(maxsize=16)
        self.condition = threading.Condition()
        self.live = set()
        self.cancelled = set()
        self.credits = {}
        self.reserved = {}
        self.closed = False

    def start(self):
        threading.Thread(target=self.read, name="tts-input", daemon=True).start()

    def read(self):
        try:
            while True:
                line = self.source.readline(64 * 1024 + 1)
                if not line:
                    return
                if len(line) > 64 * 1024:
                    while line and not line.endswith(b"\n"):
                        line = self.source.readline(64 * 1024 + 1)
                    self.invalid(None)
                    continue
                try:
                    self.accept(json.loads(line))
                except (ValueError, UnicodeError, TypeError):
                    self.invalid(None)
        finally:
            with self.condition:
                self.closed = True
                self.condition.notify_all()

    def invalid(self, request_id):
        self.send({"type": "error", "id": request_id, "code": "invalid-request"})

    def accept(self, value):
        request_id = value.get("id") if isinstance(value, dict) else None
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
            raise ValueError("invalid-request")
        kind = value.get("type", "synthesize")
        with self.condition:
            if kind == "consume":
                index = value.get("index")
                if type(index) is not int or index < 0:
                    raise ValueError("invalid-index")
                self.credits.pop((request_id, index), None)
                self.condition.notify_all()
            elif kind == "cancel":
                if request_id in self.live:
                    self.cancelled.add(request_id)
                self.condition.notify_all()
            elif kind == "synthesize":
                if request_id in self.live or any(key[0] == request_id for key in self.credits):
                    self.invalid(request_id)
                    return
                try:
                    self.requests.put_nowait(value)
                    self.live.add(request_id)
                except queue.Full:
                    self.invalid(request_id)
            else:
                raise ValueError("invalid-request")

    def take(self):
        while not self.closed:
            try:
                return self.requests.get(timeout=0.1)
            except queue.Empty:
                pass
        return None

    def check(self, request_id):
        if self.closed or request_id in self.cancelled:
            raise StreamCancelled()

    def reserve(self, request_id):
        """Reserve a full output portion before advancing the generator, not after it."""
        blocked = False
        with self.condition:
            self.check(request_id)
            while sum(self.credits.values()) + sum(self.reserved.values()) + CHUNK_RESERVATION_SECONDS > MAX_BUFFERED_SECONDS + 1e-9:
                if not blocked:
                    self.send({"type": "stream-blocked", "id": request_id, "blocked": True})
                    blocked = True
                self.condition.wait()
                self.check(request_id)
            if blocked:
                self.send({"type": "stream-blocked", "id": request_id, "blocked": False})
            self.reserved[request_id] = CHUNK_RESERVATION_SECONDS

    def publish(self, request_id, index, duration):
        with self.condition:
            self.check(request_id)
            reserved = self.reserved.get(request_id, 0)
            if not math.isfinite(duration) or not 0 < duration <= reserved + 1e-9:
                raise ValueError("invalid-stream-duration")
            self.reserved.pop(request_id)
            self.credits[(request_id, index)] = duration

    def finish(self, request_id):
        with self.condition:
            self.live.discard(request_id)
            self.cancelled.discard(request_id)
            self.reserved.pop(request_id, None)
            # Delivered files and their credits still belong to the playback queue.
            self.condition.notify_all()
