import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Local MLX speech requires Apple Silicon macOS");
const root = fileURLToPath(new URL("../", import.meta.url));
const local = join(root, ".local", "tts");
const python = join(local, ".venv", "bin", "python");
const cache = join(local, "cache", "pip");
mkdirSync(cache, { recursive: true });
const env = { ...process.env, PIP_CACHE_DIR: cache, PIP_DISABLE_PIP_VERSION_CHECK: "1" };

/** Every install runs inside the dedicated virtual environment, never global Python. */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Local TTS setup failed (${result.status ?? "signal"})`);
}

if (!existsSync(python)) {
  const candidates = [process.env.CODEXBRIDGE_TTS_PYTHON, "python3.12",
    join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3")].filter(Boolean);
  const runtime = candidates.find(candidate => spawnSync(candidate,
    ["-c", "import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)"], { stdio: "ignore" }).status === 0);
  if (!runtime) throw new Error("Python 3.12 is required; set CODEXBRIDGE_TTS_PYTHON to its executable");
  run(runtime, ["-m", "venv", join(local, ".venv")]);
}
run(python, ["-m", "pip", "install", "--require-virtualenv", "--no-input", "-r", "packages/companions/tts/requirements.txt"]);
run(python, ["packages/companions/tts/download.py"]);
