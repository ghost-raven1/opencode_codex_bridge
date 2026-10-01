import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tool, type Plugin } from "@opencode-ai/plugin";
import { CompanionDirector } from "./director.js";
import { readConfig } from "./config.js";
import { validateAtlas } from "./atlas.js";
import { startNativeHost, type NativeEvent, type NativeHost } from "./native-host.js";
import { LocalTts } from "./local-tts.js";
import { SpeechRouter } from "./speech-router.js";
import { CompanionLifecycle } from "./lifecycle.js";
import { DictationDrafts, type DictationDraft } from "./dictation-drafts.js";

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
  const report = (error: unknown): void => {
    log(String(error)); void toast(String(error), "error").catch(() => undefined);
  };
  if (process.platform !== "darwin") { log("System voice and desktop companions require macOS."); return {}; }
  const binary = fileURLToPath(new URL("../native/CodexBridge Companions.app/Contents/MacOS/Companions", import.meta.url));
  const atlas = fileURLToPath(new URL("../native/CodexBridge Companions.app/Contents/Resources/team-atlas.png", import.meta.url));
  try { await access(binary); }
  catch { log("Run npm run companion:build before enabling system voice."); return {}; }
  const args = ["--config", JSON.stringify(config)];
  try { await validateAtlas(atlas); args.push("--atlas", atlas); }
  catch (error) { log(`${error instanceof Error ? error.message : String(error)}. System voice remains enabled.`); }
  let drafts: DictationDrafts | undefined;
  try { drafts = await DictationDrafts.open(directory); } catch (error) { report(error); }
  let speech: SpeechRouter | undefined, host: NativeHost | undefined;
  let connected = false, disposed = false, connection: Promise<void> | undefined, generation = 0;
  const send = (event: object): void => {
    if (!connected || disposed) return;
    try { host!.send(event); } catch { connected = false; speech?.dispose(); host?.close(); }
  };
  const lifecycle = new CompanionLifecycle(config, event => speech?.event(event));
  const director = new CompanionDirector(config, event => lifecycle.event(event));
  const syncDrafts = (): void => send({ type: "drafts", project: directory,
    items: drafts?.list().map(({ id, text, createdAt }) => ({ id, preview: text.slice(0, 120), createdAt })) ?? [] });
  const publish = async (draft: DictationDraft): Promise<void> => {
    const result = await client.tui.appendPrompt({ query: { directory }, body: { text: draft.text + " " }, signal: AbortSignal.timeout(5000) });
    if (result.error) throw new Error("Не удалось отправить диктовку в CLI. Черновик сохранён в меню ✦.");
    await toast("Диктовка отправлена в CLI. Проверь строку ввода; копия сохранена в меню ✦ → Черновики.");
  };
  let delivery = Promise.resolve();
  const receive = (event: NativeEvent): void => {
    if (disposed) return;
    if (event.type === "closed") { connected = false; speech?.dispose(); }
    speech?.receive(event);
    if (event.type === "transcript" && typeof event.text === "string" && event.text.trim()) {
      const text = event.text;
      void (async () => {
        if (!drafts) throw new Error("История диктовки недоступна. Текст не отправлен; проверь права каталога данных.");
        const draft = await drafts.add(text);
        syncDrafts();
        delivery = delivery.catch(() => undefined).then(async () => { if (!disposed) await publish(draft); });
        void delivery.catch(report);
      })().catch(report);
    } else if (event.type === "draft-action") {
      void (async () => {
        if (!drafts) throw new Error("История диктовки недоступна.");
        if (event.action === "clear") { await drafts.clear(); syncDrafts(); }
        else if (typeof event.id === "string") {
          if (event.action === "insert") await drafts.recover(publish, event.id);
          else if (event.action === "copy" || event.action === "view") {
            const draft = drafts.get(event.id);
            if (draft) send({ type: "draft-text", action: event.action, text: draft.text });
          }
        }
      })().catch(report);
    } else if (event.type === "error" && typeof event.message === "string") report(event.message);
    else if (event.type === "dictation") {
      void toast(event.active ? "Микрофон включён. Заверши или отмени диктовку в меню ✦." : "Микрофон выключен.").catch(() => undefined);
    }
  };
  const connect = (): Promise<void> => {
    if (connected || disposed) return Promise.resolve();
    if (connection) return connection;
    const current = ++generation;
    connection = (async () => {
      host = await startNativeHost(binary, args, event => { if (current === generation) receive(event); }, log);
      if (disposed) { host.close(); return; }
      connected = true;
      speech = new SpeechRouter(config, new LocalTts({ log }), send, log, undefined, {
        changed: (pending, speaker) => lifecycle.speechActivity(pending, speaker),
        voiceFor: (id, role) => lifecycle.voiceFor(id, role),
      });
      syncDrafts(); lifecycle.replay();
    })().finally(() => { connection = undefined; });
    return connection;
  };
  try { await connect(); } catch (error) { log(String(error)); }
  const dispose = (): void => { disposed = true; lifecycle.dispose(); speech?.dispose(); host?.close(); };
  return {
    dispose: async () => dispose(),
    event: async ({ event }) => {
      if (disposed) return;
      if (event.type === "server.instance.disposed") dispose();
      else director.event(event);
    },
    "chat.message": async (input, output) => {
      const task = output.parts.filter(part => part.type === "text" && !part.synthetic && !part.ignored)
        .map(part => part.type === "text" ? part.text : "").join("\n");
      director.assignTask(input.sessionID, { agent: input.agent ?? output.message.agent,
        task, messageID: output.message.id });
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task" || typeof output?.metadata?.sessionId !== "string") return;
      const args = input.args as Record<string, unknown>;
      director.assignTask(output.metadata.sessionId, { parentID: input.sessionID,
        agent: typeof args.subagent_type === "string" ? args.subagent_type : undefined,
        task: [args.description, args.prompt].filter(value => typeof value === "string").join("\n") });
      // This fallback runs after execution; a child whose stream was missed is already finished.
      director.completeTask(output.metadata.sessionId);
    },
    tool: {
      companion: tool({
        description: "Control native macOS companions. Dictation is retained as local text drafts, never automatically submitted. recover_dictation republishes the latest draft; OpenCode does not acknowledge insertion.",
        args: { action: tool.schema.enum(["preview", "hide", "show", "reset_position", "voice_menu", "test_voice", "mute", "unmute", "stop", "dictation_on", "dictation_off", "recover_dictation", "clear_dictation"]) },
        async execute({ action }) {
          if (action === "recover_dictation") {
            if (!drafts) throw new Error("История диктовки недоступна.");
            await drafts.recover(publish);
            return "Событие вставки отправлено. Проверь текст в CLI; черновик сохранён.";
          }
          if (action === "clear_dictation") { await drafts?.clear(); syncDrafts(); return "История диктовки очищена."; }
          await connect();
          const events = {
            hide: { type: "hide" }, show: { type: "show" }, reset_position: { type: "reset-position" },
            preview: { type: "preview" }, voice_menu: { type: "show-menu" }, test_voice: { type: "speech-test" },
            mute: { type: "mute", muted: true }, unmute: { type: "mute", muted: false }, stop: { type: "stop-speech" },
            dictation_on: { type: "dictation-enable" }, dictation_off: { type: "dictation-disable" },
          };
          host!.send(events[action]);
          return action === "voice_menu" ? "Меню ✦ открыто. Нажми «Начать диктовку»; после остановки проверь текст в CLI." : `Companion: ${action}`;
        },
      }),
    },
  };
};
export default Companions;
