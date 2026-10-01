import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { CompanionDirector } from "./director.js";
import { readConfig } from "./config.js";
import { validateAtlas } from "./atlas.js";

/** Optional native companion, isolated from the bridge and from OpenCode's tool lifecycle. */
const Companions: Plugin = async ({ directory, client }) => {
  const config = await readConfig(directory);
  if (!config.enabled) return {};
  const log = (message: string): void => {
    void client.app.log({ body: { service: "codexbridge-companions", level: "warn", message } }).catch(() => undefined);
  };
  if (process.platform !== "darwin") { log("Desktop companions currently require macOS; CLI bridge remains available."); return {}; }
  const binary = fileURLToPath(new URL("../native/Companions", import.meta.url));
  const atlas = fileURLToPath(new URL("../assets/team-atlas.png", import.meta.url));
  try { await access(binary); await access(atlas); }
  catch { log("Run npm run companion:build before enabling companions."); return {}; }
  try { await validateAtlas(atlas); }
  catch (error) { log(error instanceof Error ? error.message : String(error)); return {}; }
  const child = spawn(binary, ["--atlas", atlas, "--config", JSON.stringify(config)], { stdio: ["pipe", "ignore", "pipe"] });
  child.stderr.resume();
  child.on("error", (error) => log(error.message));
  child.stdin.on("error", () => undefined);
  const director = new CompanionDirector(config, (event) => {
    if (!child.stdin.destroyed && child.stdin.writableLength < 512_000) child.stdin.write(JSON.stringify(event) + "\n");
  });
  const stop = (): void => { child.stdin.end(); child.kill("SIGTERM"); };
  process.once("exit", stop);
  child.once("close", () => process.removeListener("exit", stop));
  return { event: async ({ event }) => {
    if (event.type === "server.instance.disposed") stop();
    else director.event(event);
  } };
};
export default Companions;
