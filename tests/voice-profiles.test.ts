import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps synthetic voice references stable and releases the previous model family", () => {
  const result = spawnSync("python3", ["-B", "scripts/test-voice-profiles.py"], { encoding: "utf8" });
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
