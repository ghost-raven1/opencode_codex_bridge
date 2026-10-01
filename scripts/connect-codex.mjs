import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { connectCodex, beginCodexLogin, CODEX_AUTH_MARKER, CODEX_PROVIDER_ID } from "../packages/bridge/dist/auth.js";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.includes("--login")) {
  const login = await beginCodexLogin();
  console.log(login.instructions);
  console.log(login.url);
  if (process.platform === "darwin") {
    const browser = spawn("open", [login.url], { stdio: "ignore" });
    browser.on("error", () => console.log("Open the login URL above in your browser."));
  }
  const result = await login.callback();
  if (result.type !== "success") throw new Error("Codex login did not finish");
}
// Catalog contains model metadata only; official Codex RPC keeps access tokens in memory.
const catalog = await connectCodex();
const directory = join(root, ".local");
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "codex-provider.json"), JSON.stringify(catalog, null, 2) + "\n");
const dataDirectory = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");
await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
const authPath = resolve(dataDirectory, "auth.json");
let auth = {};
try { auth = JSON.parse(await readFile(authPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot safely update OpenCode auth metadata"); }
if (auth[CODEX_PROVIDER_ID]?.type !== "api" || auth[CODEX_PROVIDER_ID]?.key !== CODEX_AUTH_MARKER) {
  auth[CODEX_PROVIDER_ID] = { type: "api", key: CODEX_AUTH_MARKER };
  const temporary = authPath + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, authPath);
  } finally { await rm(temporary, { force: true }); }
}
console.log(`CodexBridge connected: ${catalog.models.length} models, selected ${catalog.defaultModel}.`);
console.log("OpenCode stores only a non-secret bridge marker. Run npm run bundle:all to update profiles.");
