import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { runCodex } from "../packages/bridge/dist/run.js";

// This explicitly separate check uses the user's Codex account/model allowance.
const root = fileURLToPath(new URL("../", import.meta.url));
const cwd = await mkdtemp(join(root, ".local/inference-smoke-"));
const result = await runCodex({ cwd, timeoutMs: 90_000,
  prompt: "Integration smoke test. Reply with exactly CODEXBRIDGE_OK. Do not inspect files, invoke tools or modify anything." });
assert.equal(result.status, "completed", result.error);
assert.equal(result.text.trim(), "CODEXBRIDGE_OK");
console.log("PASS: real Codex inference through stdio; CODEXBRIDGE_OK");
