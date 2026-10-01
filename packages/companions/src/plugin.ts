import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tool, type Plugin } from "@opencode-ai/plugin";
import { CompanionDirector } from "./director.js";
import { readConfig } from "./config.js";
import { validateAtlas } from "./atlas.js";
import { startNativeHost, type NativeEvent } from "./native-host.js";

/** System voice and dictation remain available when optional character artwork is missing. */
const Companions: Plugin = async ({ directory, client }) => {
  const config = await readConfig(directory);
  if (!config.enabled) return {};
  const log = (message: string): void => {
    void client.app.log({ body: { service: "codexbridge-companions", level: "warn", message } }).catch(() => undefined);
  };
  const toast = async (message: string, variant: "info" | "error" = "info"): Promise<void> => {
    await client.tui.showToast({ query: { directory }, body: { title: "CodexBridge", message, variant } });
  };
  if (process.platform !== "darwin") { log("System voice and desktop companions require macOS."); return {}; }
  const binary = fileURLToPath(new URL("../native/CodexBridge Companions.app/Contents/MacOS/Companions", import.meta.url));
  const atlas = fileURLToPath(new URL("../assets/team-atlas.png", import.meta.url));
  try { await access(binary); }
  catch { log("Run npm run companion:build before enabling system voice."); return {}; }
  const args = ["--config", JSON.stringify(config)];
  try { await validateAtlas(atlas); args.push("--atlas", atlas); }
  catch (error) { log(`${error instanceof Error ? error.message : String(error)}. System voice remains enabled.`); }
  if (config.showOnStart) args.push("--preview");
  const pendingTranscripts: string[] = [];
  let delivery = Promise.resolve();
  const deliverTranscript = async (): Promise<void> => {
    while (pendingTranscripts.length) {
      const text = pendingTranscripts[0]!;
      const result = await client.tui.appendPrompt({ query: { directory }, body: { text: text + " " } });
      if (result.error) throw new Error("Не удалось вставить диктовку. Вызови companion → recover_dictation.");
      pendingTranscripts.shift();
      await toast("Диктовка вставлена в строку ввода. Проверь текст и нажми Enter.");
    }
  };
  const scheduleDelivery = (): Promise<void> => {
    delivery = delivery.catch(() => undefined).then(deliverTranscript);
    return delivery;
  };
  const report = (error: unknown): void => {
    log(String(error)); void toast(String(error), "error").catch(() => undefined);
  };
  const receive = (event: NativeEvent): void => {
    if (event.type === "transcript" && typeof event.text === "string" && event.text.trim()) {
      if (event.text.length > 16000 || pendingTranscripts.length >= 16) {
        report("Очередь диктовки заполнена или запись слишком длинная. Новая запись не принята; восстанови черновики и повтори её.");
        return;
      }
      pendingTranscripts.push(event.text.trim());
      void scheduleDelivery().catch(report);
    } else if (event.type === "error" && typeof event.message === "string") {
      log(event.message); void toast(event.message, "error").catch(() => undefined);
    } else if (event.type === "dictation") {
      void toast(event.active ? "Микрофон включён. Заверши или отмени диктовку в меню ✦." : "Микрофон выключен.").catch(() => undefined);
    }
  };
  let host;
  try { host = await startNativeHost(binary, args, receive, log); }
  catch (error) { log(String(error)); return {}; }
  const director = new CompanionDirector(config, event => {
    try { host.send(event); } catch { /* Closing the companion must not interrupt a coding task. */ }
  });
  return {
    dispose: async () => host.close(),
    event: async ({ event }) => {
      if (event.type === "server.instance.disposed") host.close();
      else director.event(event);
    },
    tool: {
      companion: tool({
        description: "Control native macOS companions. voice_menu opens the menu where the user explicitly starts dictation. Recognized text is a draft in the CLI, never submitted automatically.",
        args: { action: tool.schema.enum(["preview", "voice_menu", "test_voice", "mute", "unmute", "stop", "recover_dictation"]) },
        async execute({ action }) {
          if (action === "recover_dictation") {
            await scheduleDelivery();
            return "Доступная диктовка вставлена в строку ввода.";
          }
          const events = {
            preview: { type: "preview" }, voice_menu: { type: "show-menu" }, test_voice: { type: "speech-test" },
            mute: { type: "mute", muted: true }, unmute: { type: "mute", muted: false }, stop: { type: "stop-speech" },
          };
          host.send(events[action]);
          return action === "voice_menu" ? "Меню ✦ открыто. Нажми «Начать диктовку»; после остановки проверь текст в CLI и нажми Enter." : `Companion: ${action}`;
        },
      }),
    },
  };
};
export default Companions;
