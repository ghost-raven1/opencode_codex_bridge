import { readFile, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { LocalSpeechAudio } from "./speech-stream.js";

/** Resolve the worker's WAV without allowing cleanup or playback outside its cache. */
export async function localAudioPath(directory: string, value: unknown): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value) || !value.endsWith(".wav")) throw new Error("Invalid WAV path");
  const [root, path] = await Promise.all([realpath(directory), realpath(value)]);
  const inside = relative(root, path);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("Invalid WAV path");
  return path;
}

/** Validate actual mono PCM16 bytes, including timing, rather than trusting JSON metadata. */
export async function localAudio(directory: string, value: Record<string, unknown>): Promise<LocalSpeechAudio> {
  if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 180 ||
      typeof value.sampleRate !== "number" || !Number.isInteger(value.sampleRate) || value.sampleRate < 8000 || value.sampleRate > 96000) throw new Error("Invalid audio metadata");
  const path = await localAudioPath(directory, value.path), file = await stat(path);
  if (!file.isFile() || file.size <= 44 || file.size > 32 * 1024 * 1024) throw new Error("Invalid audio size");
  const bytes = await readFile(path);
  if (bytes.length !== file.size || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" ||
      bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error("Invalid WAV header");
  let pcm = false, samples = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString("ascii", offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > bytes.length) throw new Error("Invalid WAV chunk");
    if (kind === "fmt ") {
      pcm = length >= 16 && bytes.readUInt16LE(start) === 1 && bytes.readUInt16LE(start + 2) === 1 &&
        bytes.readUInt32LE(start + 4) === value.sampleRate && bytes.readUInt32LE(start + 8) === value.sampleRate * 2 &&
        bytes.readUInt16LE(start + 12) === 2 && bytes.readUInt16LE(start + 14) === 16;
    } else if (kind === "data") {
      if (samples || length % 2) throw new Error("Invalid PCM data");
      samples = length / 2;
    }
    offset = start + length + length % 2;
  }
  const duration = samples / value.sampleRate;
  if (!pcm || !samples || Math.abs(duration - value.duration) > 1 / value.sampleRate + 1e-9) throw new Error("Invalid PCM duration");
  return { path, duration, sampleRate: value.sampleRate };
}

/** Late output is removable only when it resolves inside the issuing worker's directory. */
export async function discardLocalAudio(directory: string, value: unknown): Promise<void> {
  try { await unlink(await localAudioPath(directory, value)); } catch { /* Missing or outside this worker's cache. */ }
}
