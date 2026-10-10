import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function readOptional(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

/** Keep the original personal settings before atomically updating a managed file. */
async function writeManaged(path, content) {
  const previous = await readOptional(path);
  if (previous === content) return;
  if (previous !== undefined) {
    try { await copyFile(path, path + ".codexbridge-backup", constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  await writeFile(path + ".codexbridge-tmp", content, { mode: 0o600 });
  await rename(path + ".codexbridge-tmp", path);
}

/** Install the bridge for ordinary OpenCode launches, preserving other providers and JSONC settings. */
export async function installOpenCode(root, configDir) {
  const plugin = join(root, "packages/bridge/dist/plugin.js");
  await access(plugin, constants.R_OK);
  const profile = JSON.parse(await readFile(join(root, ".local/profiles/quiet/opencode.json"), "utf8"));
  const configFile = join(configDir, "opencode.json");
  const existing = await readOptional(configFile);
  const config = existing === undefined ? {} : JSON.parse(existing);
  config.$schema ??= "https://opencode.ai/config.json";
  config.model ??= profile.model;
  config.small_model ??= profile.small_model;
  config.provider = { ...config.provider, codexbridge: {
    ...config.provider?.codexbridge, ...profile.provider.codexbridge,
    models: { ...config.provider?.codexbridge?.models, ...profile.provider.codexbridge.models },
  } };
  const permission = config.permission;
  const inherited = typeof permission === "string" ? permission : permission?.["*"];
  const bridgePermission = inherited === "deny" ? "deny" : "ask";
  config.permission = typeof permission === "string"
    ? { "*": permission, codex: bridgePermission, codex_system: bridgePermission }
    : { codex: bridgePermission, codex_system: bridgePermission, ...permission };
  config.command = { codex: profile.command.codex, ...config.command };
  const pluginDir = join(configDir, "plugins");
  await mkdir(pluginDir, { recursive: true });
  await writeManaged(configFile, JSON.stringify(config, null, 2) + "\n");
  const entry = join(pluginDir, "codex-bridge.js");
  await writeManaged(entry, `export { default } from ${JSON.stringify(pathToFileURL(plugin).href)};\n`);
  return { configFile, entry };
}
