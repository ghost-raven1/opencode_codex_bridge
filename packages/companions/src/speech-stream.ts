/** Shared local synthesis contract; one request keeps its voice for every audio portion. */
export interface LocalSpeechRequest { id: string; text: string; voice: string; instructions?: string }
export interface LocalSpeechAudio { path: string; duration: number; sampleRate: number }
export interface LocalSpeechChunk extends LocalSpeechAudio { index: number }
export interface LocalSpeechStreamObserver {
  start?(): void;
  chunk(audio: LocalSpeechChunk): void;
}

/** Consumption credits apply only after playback, not after a file enters the native buffer. */
export interface StreamingSpeechGenerator {
  stream(request: LocalSpeechRequest, observer: LocalSpeechStreamObserver, signal?: AbortSignal): Promise<void>;
  consumed(id: string, index: number): void;
}

export const speechStreamPolicy = {
  chunkSeconds: 2,
  prefillSeconds: 4,
  maxBufferedSeconds: 12,
  startupWaitMs: 20_000,
  underrunWaitMs: 10_000,
} as const;
