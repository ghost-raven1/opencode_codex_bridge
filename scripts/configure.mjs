import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mcpConfiguration } from "./lib/mcp-config.mjs";
import { agentConfiguration } from "./lib/agent-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = process.argv[2] ?? "quiet";
if (!["jarvis", "quiet"].includes(profile)) throw new Error("Profile: jarvis | quiet");
const target = resolve(root, ".local", "profiles", profile);
let catalog;
try { catalog = JSON.parse(await readFile(join(root, ".local/codex-provider.json"), "utf8")); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  throw new Error("Connect the bridge first: npm run connect:codex");
}
if (!catalog.models?.some(model => model.id === catalog.defaultModel)) throw new Error("Refresh the Codex model catalog: npm run connect:codex");
const models = Object.fromEntries(catalog.models.map(model => [model.id, {
  name: model.name, reasoning: true, temperature: false, tool_call: true,
  attachment: model.inputModalities.includes("image"),
  modalities: { input: model.inputModalities.filter(type => ["text", "image"].includes(type)), output: ["text"] },
  // Conservative local history budgets, not claims about the model's maximum capacity.
  limit: { context: 200_000, output: 32_000 },
  options: { reasoningEffort: model.defaultReasoningEffort, store: false },
  variants: Object.fromEntries(model.reasoningEfforts.map(effort => [effort, { reasoningEffort: effort }])),
}]));
await mkdir(target, { recursive: true });
const file = path => pathToFileURL(join(root, path)).href;
// OpenCode 1.3 deduplicates local plugins by filename: every entry must have a unique basename.
await mkdir(join(target, "entries"), { recursive: true });
const pluginEntries = [
  ["codex-bridge", "packages/bridge/dist/plugin.js"],
  ["snip", "node_modules/opencode-snip/.opencode/plugins/index.ts"],
  ["plannotator", "node_modules/@plannotator/opencode/dist/index.js"],
  ["smart-voice", "node_modules/opencode-smart-voice-notify/dist/index.js"],
];
for (const [name, source] of pluginEntries) {
  await writeFile(join(target, "entries", name + ".mjs"), `export { default } from ${JSON.stringify(file(source))};\n`);
}
const config = {
  $schema: "https://opencode.ai/config.json",
  model: `codexbridge/${catalog.defaultModel}`,
  small_model: `codexbridge/${catalog.models.find(model => model.id === "gpt-5.6-luna")?.id ?? catalog.defaultModel}`,
  default_agent: "build",
  agent: agentConfiguration(),
  provider: { codexbridge: { name: "Codex via bridge", npm: "@ai-sdk/openai",
    options: { baseURL: "https://chatgpt.com/backend-api/codex" }, models } },
  plugin: pluginEntries.map(([name]) => pathToFileURL(join(target, "entries", name + ".mjs")).href),
  permission: { codex: "ask", codex_system: "ask" },
  mcp: mcpConfiguration(root),
  lsp: {
    typescript: { command: [process.execPath, join(root, "node_modules/typescript-language-server/lib/cli.mjs"), "--stdio"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] },
  },
  command: {
    codex: { description: "Передать задачу Codex через stdio", template: "Use the codex tool for this task. Preserve threadId for follow-ups. Task: $ARGUMENTS" },
  },
};
await writeFile(join(target, "opencode.json"), JSON.stringify(config, null, 2) + "\n");
await writeFile(join(target, "smart-voice-notify.jsonc"), JSON.stringify({
  enabled: profile !== "quiet", enableTTS: false, enableTTSReminder: false,
  enableFollowUpReminders: false, enableSound: false, notificationMode: "sound-only",
  enableDesktopNotification: true, enableToast: true, enableAIMessages: false,
  enableWebhook: false, wakeMonitor: false, forceVolume: false,
}, null, 2) + "\n");
console.log(`Profile ready: ${target}\nRun: npm start -- ${profile} /path/to/project`);
