import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { speechBudget } from "../packages/companions/src/speech-budget.js";

const short = "Публичная короткая фраза".padEnd(32, ".");
const long = "Проверю русский текст и документацию. ".repeat(10).slice(0, 319) + ".";

describe("local speech generation budget", () => {
  it("allows slow Russian phrases, expands numbers, and bounds pathological input", () => {
    expect(short).toHaveLength(32);
    expect(long).toHaveLength(320);
    expect(speechBudget(short)).toEqual({ seconds: 15, tokens: 188 });
    expect(speechBudget(long).seconds).toBeCloseTo(320 / 6 + 4);
    expect(speechBudget("1234567890".repeat(10)).seconds).toBeCloseTo(400 / 6 + 4);
    expect(speechBudget("1".repeat(2000))).toEqual({ seconds: 120, tokens: 1500 });
  });
  it("agrees with the worker and rejects both a 45-second short reply and token-truncated output", async () => {
    const cases = [short, long, "1234567890".repeat(10), "1".repeat(2000), "１２３４５ ".repeat(20), "🎙️ Русская речь."];
    const { stdout } = await promisify(execFile)("python3", ["-c", `
import json, sys
sys.path.insert(0, sys.argv[1])
from speech_budget import speech_budget, check_generation, SpeechLimitError
result = []
for text in json.loads(sys.argv[2]):
    seconds, tokens = speech_budget(text)
    checks = []
    for count, duration in [(tokens - 1, seconds), (tokens, seconds), (1, seconds + 0.1)]:
        try:
            check_generation(count, tokens, duration, seconds)
            checks.append(True)
        except SpeechLimitError:
            checks.append(False)
    result.append({"seconds": seconds, "tokens": tokens, "checks": checks})
seconds, tokens = speech_budget(json.loads(sys.argv[2])[0])
try:
    check_generation(564, tokens, 45.12, seconds)
    overrun = True
except SpeechLimitError:
    overrun = False
print(json.dumps({"budgets": result, "overrunAccepted": overrun}))
`, fileURLToPath(new URL("../packages/companions/tts/", import.meta.url)), JSON.stringify(cases)],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    const result = JSON.parse(stdout);
    expect(result.budgets).toEqual(cases.map(text => ({ ...speechBudget(text), checks: [true, false, false] })));
    expect(result.overrunAccepted).toBe(false);
  });
});
