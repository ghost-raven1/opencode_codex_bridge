import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
let problems = 0;
function check(name, ok, detail) { console.log(`${ok ? "OK" : "MISSING"} ${name}: ${detail}`); if (!ok) problems++; }
check("Node", Number(process.versions.node.split(".")[0]) === 24 && Number(process.versions.node.split(".")[1]) >= 15, process.versions.node + " (requires 24.15+)");
for (const command of ["codex", "opencode", "snip"]) {
  const local = command === "snip" ? join(root, ".local/bin/snip") : command === "codex" ? join(root, "node_modules/.bin/codex") : command;
  const result = spawnSync(local, ["--version"], { encoding: "utf8", timeout: 15_000 });
  const fallback = result.error && command === "snip" ? spawnSync(command, ["--version"], { encoding: "utf8", timeout: 15_000 }) : result;
  check(command, fallback.status === 0, (fallback.stdout ?? "").trim() || fallback.error?.message || "not available");
}
for (const path of ["packages/bridge/dist/plugin.js", "packages/companions/dist/plugin.js", "packages/companions/assets/team-atlas.png", "packages/companions/native/Companions"]) {
  try { await access(join(root, path), constants.R_OK); check(path, true, "present"); }
  catch { check(path, false, "run build / companion:build"); }
}
try {
  const catalog = JSON.parse(await readFile(join(root, ".local/codex-provider.json"), "utf8"));
  check("Codex model catalog", catalog.models?.some(model => model.id === catalog.defaultModel),
    `${catalog.models?.length ?? 0} models; default ${catalog.defaultModel} (run smoke:provider to verify inference)`);
} catch { check("Codex model catalog", false, "run npm run connect:codex and npm run bundle:all"); }
try {
  const { validateAtlas } = await import("../packages/companions/dist/atlas.js");
  await validateAtlas(join(root, "packages/companions/assets/team-atlas.png"));
  console.log("OK companion atlas: transparent PNG with a uniform grid");
} catch (error) { console.warn(`WARN optional companion artwork: ${error.message}`); }
process.exitCode = problems ? 1 : 0;
