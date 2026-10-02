import { readFileSync } from "node:fs";

const policy = JSON.parse(readFileSync(new URL("../tts/speech-budget.json", import.meta.url), "utf8")) as {
  minimumSeconds: number; maximumSeconds: number; charactersPerSecond: number;
  paddingSeconds: number; extraCharactersPerDigit: number; framesPerSecond: number;
};

/** Shared with the Python worker; numbers receive time to expand into spoken words. */
export function speechBudget(text: string): { seconds: number; tokens: number } {
  const characters = [...text.trim()];
  const digits = characters.filter(character => /\p{Nd}/u.test(character)).length;
  const estimated = (characters.length + policy.extraCharactersPerDigit * digits) / policy.charactersPerSecond;
  const seconds = Math.min(policy.maximumSeconds, Math.max(policy.minimumSeconds, estimated + policy.paddingSeconds));
  return { seconds, tokens: Math.ceil(seconds * policy.framesPerSecond) };
}
