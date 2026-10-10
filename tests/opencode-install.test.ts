import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { installOpenCode } from "../scripts/lib/opencode-install.mjs";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true }); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "codexbridge-install-"));
  directories.push(directory);
  const root = join(directory, "bridge with spaces"), configDir = join(directory, "global config");
  await mkdir(join(root, "packages/bridge/dist"), { recursive: true });
  await writeFile(join(root, "packages/bridge/dist/plugin.js"), "export default async () => ({});\n");
  await mkdir(join(root, ".local/profiles/quiet"), { recursive: true });
  const profile = { model: "codexbridge/model", small_model: "codexbridge/small",
    provider: { codexbridge: { name: "Codex via bridge", models: { model: { name: "Model" } } } },
    command: { codex: { template: "Use codex: $ARGUMENTS" } } };
  await writeFile(join(root, ".local/profiles/quiet/opencode.json"), JSON.stringify(profile));
  return { root, configDir, profile };
}

it("installs an automatically discovered plugin with encoded workspace paths and a bridge provider", async () => {
  const { root, configDir, profile } = await fixture();
  const { configFile, entry } = await installOpenCode(root, configDir);
  expect(entry).toBe(join(configDir, "plugins/codex-bridge.js"));
  expect(await readFile(entry, "utf8")).toBe(`export { default } from ${JSON.stringify(pathToFileURL(join(root, "packages/bridge/dist/plugin.js")).href)};\n`);
  expect(JSON.parse(await readFile(configFile, "utf8"))).toMatchObject({ ...profile,
    permission: { codex: "ask", codex_system: "ask" } });
});

it("preserves personal providers, commands, models, stricter permissions and JSONC across repeated installs", async () => {
  const { root, configDir } = await fixture();
  await mkdir(configDir);
  const configFile = join(configDir, "opencode.json");
  const original = JSON.stringify({ model: "personal/model", plugin: ["personal-plugin"],
    provider: { personal: { name: "Personal" } }, permission: { codex: "deny", edit: "deny" },
    command: { personal: { template: "Personal task" } } });
  const jsonc = "{\n  // Personal preference\n  \"model\": \"override/model\",\n}\n";
  await writeFile(configFile, original);
  await writeFile(join(configDir, "opencode.jsonc"), jsonc);
  await installOpenCode(root, configDir);
  const first = await readFile(configFile, "utf8");
  await installOpenCode(root, configDir);
  expect(await readFile(configFile, "utf8")).toBe(first);
  expect(await readFile(configFile + ".codexbridge-backup", "utf8")).toBe(original);
  expect(await readFile(join(configDir, "opencode.jsonc"), "utf8")).toBe(jsonc);
  expect(JSON.parse(first)).toMatchObject({ model: "personal/model", plugin: ["personal-plugin"],
    provider: { personal: { name: "Personal" } }, command: { personal: { template: "Personal task" } },
    permission: { codex: "deny", codex_system: "ask", edit: "deny" } });
});

it.each(["deny", { "*": "deny" }])("keeps a blanket denial in effect for both bridge permissions: %j", async permission => {
  const { root, configDir } = await fixture();
  await mkdir(configDir);
  await writeFile(join(configDir, "opencode.json"), JSON.stringify({ permission }));
  const { configFile } = await installOpenCode(root, configDir);
  expect(JSON.parse(await readFile(configFile, "utf8")).permission).toEqual({ "*": "deny", codex: "deny", codex_system: "deny" });
});
