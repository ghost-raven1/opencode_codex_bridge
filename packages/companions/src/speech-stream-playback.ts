import type { LocalSpeechChunk } from "./speech-stream.js";

/** Owns issued WAVs until PCM copy, and worker credits until playback or cancellation. */
export class SpeechStreamPlayback {
  readonly abort = new AbortController();
  private chunks = new Map<number, { audio: LocalSpeechChunk; accepted: boolean; consumed: boolean }>();
  active = false;
  done = false;
  finished = false;
  buffering = false;
  private closed = false;
  private endSent = false;
  constructor(readonly id: string, private send: (event: object) => void,
    private remove: (path: string) => Promise<unknown>, private consumed: (id: string, index: number) => void) {}

  get count(): number { return this.chunks.size; }
  get duration(): number { return [...this.chunks.values()].reduce((sum, item) => sum + item.audio.duration, 0); }

  chunk(audio: LocalSpeechChunk): boolean {
    if (this.closed) { void this.remove(audio.path); this.consumed(this.id, audio.index); return false; }
    if (audio.index !== this.chunks.size || !Number.isInteger(audio.index) || audio.duration <= 0 ||
        !Number.isFinite(audio.duration) || !Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0 || !audio.path) {
      void this.remove(audio.path); this.consumed(this.id, audio.index); throw new Error("Invalid speech chunk");
    }
    this.chunks.set(audio.index, { audio, accepted: false, consumed: false });
    if (this.active) this.sendChunk(audio);
    return true;
  }

  start(characterId: string, role: string, text: string, captionId?: string, captionOffset = 0): void {
    if (this.closed || this.active) return;
    this.active = true;
    this.send({ type: "audio-stream-start", audioId: this.id, characterId, role, text,
      ...(captionId ? { captionId, captionOffset } : {}) });
    for (const { audio } of this.chunks.values()) {
      if (this.closed) return;
      this.sendChunk(audio);
    }
    this.end();
  }

  private sendChunk(audio: LocalSpeechChunk): void {
    this.send({ type: "audio-stream-chunk", audioId: this.id, ...audio });
  }

  end(): void {
    if (!this.closed && this.active && this.done && !this.endSent) {
      this.endSent = true;
      this.send({ type: "audio-stream-end", audioId: this.id, chunks: this.count });
    }
  }

  accept(index: number): void {
    const item = this.chunks.get(index);
    if (!item || item.accepted) return;
    item.accepted = true; void this.remove(item.audio.path);
  }

  consume(index: number): void {
    const item = this.chunks.get(index);
    if (!item || item.consumed) return;
    this.accept(index); item.consumed = true; this.consumed(this.id, index);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.abort.abort();
    for (const index of this.chunks.keys()) this.consume(index);
  }
}
