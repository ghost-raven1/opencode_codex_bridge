import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tool, type Plugin } from "@opencode-ai/plugin";
import { CompanionDirector, spokenText } from "./director.js";
import { readConfig } from "./config.js";
import { validateAtlas } from "./atlas.js";
import { startNativeHost, type NativeEvent, type NativeHost } from "./native-host.js";
import { LocalTts } from "./local-tts.js";
import { SpeechRouter } from "./speech-router.js";
import { CompanionLifecycle } from "./lifecycle.js";
import { DictationDrafts, type DictationDraft } from "./dictation-drafts.js";
import { executeVoiceCommand, isVoiceCommand, type VoiceCommand } from "./voice-commands.js";
import { OpeningPhrases } from "./opening-phrases.js";
import { DiagnosticLog, type DiagnosticEvent } from "./diagnostic-log.js";

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
  const diagnostics = await DiagnosticLog.open(directory).catch(() => undefined);
  const diagnostic = diagnostics?.record;
  if (diagnostics) log(`Companion diagnostics: ${diagnostics.path}`);
  let speech: SpeechRouter | undefined, host: NativeHost | undefined;
  let connected = false, disposed = false, connection: Promise<void> | undefined, generation = 0;
  const send = (event: object): void => {
    if (!connected || disposed) return;
    try { host!.send(event); } catch { diagnostic?.("native-error", { reason: "input-failed" }); connected = false; speech?.dispose(); host?.close(); }
  };
  const lifecycle = new CompanionLifecycle(config, event => speech?.event(event), diagnostic);
  const director = new CompanionDirector(config, event => lifecycle.event(event));
  const openings = new OpeningPhrases();
  const syncDrafts = (): void => send({ type: "drafts", project: directory,
    items: drafts?.list().map(({ id, text, createdAt }) => ({ id, preview: text.slice(0, 120), createdAt })) ?? [] });
  let submitBlocked = false;
  const publish = async (draft: DictationDraft): Promise<void> => {
    try {
      const result = await client.tui.appendPrompt({ query: { directory }, body: { text: draft.text + " " }, signal: AbortSignal.timeout(5000) });
      if (result.error) throw new Error("Не удалось отправить диктовку в CLI. Черновик сохранён в меню ✦.");
      submitBlocked = false;
    } catch (error) { submitBlocked = true; throw error; }
    await toast("Диктовка отправлена в CLI. Проверь строку ввода; копия сохранена в меню ✦ → Черновики.").catch(log);
  };
  let delivery = Promise.resolve();
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    delivery = delivery.catch(() => undefined).then(async () => { if (!disposed) await operation(); });
    return delivery;
  };
  const recover = (draft: DictationDraft): Promise<void> => enqueue(() => publish(draft));
  const command = async (action: VoiceCommand): Promise<void> => {
    if (action === "submit" && submitBlocked) throw new Error("Диктовка не была передана в CLI. Сначала восстанови черновик или очисти ввод; старый запрос не отправлен.");
    await executeVoiceCommand(action, client, directory, send);
    if (action === "clear" || action === "new-task") submitBlocked = false;
    if (action === "submit") await toast("Команда отправки передана в CLI. Проверь начало задачи в OpenCode.").catch(log);
  };
  const receive = (event: NativeEvent): void => {
    if (disposed) return;
    if (event.type === "closed") { diagnostic?.("native-close", { reason: "closed" }); connected = false; speech?.dispose(); }
    if (event.type === "diagnostic") diagnostic?.(event.event as DiagnosticEvent, event);
    speech?.receive(event);
    if (event.type === "transcript" || event.type === "voice-command") {
      const action = event.type === "voice-command" && isVoiceCommand(event.command) ? event.command : undefined;
      if (event.type === "voice-command" && !action) return;
      const text = typeof event.text === "string" ? event.text.trim() : "";
      if (text && (action === undefined || action === "submit")) {
        // Persist immediately even while an older network operation is pending; preserve event order.
        const saved = drafts ? drafts.add(text).then(draft => { syncDrafts(); return draft; })
          : Promise.reject(new Error("История диктовки недоступна. Текст не отправлен; проверь права каталога данных."));
        void saved.catch(() => undefined);
        void enqueue(async () => {
          let draft: DictationDraft;
          try { draft = await saved; } catch (error) { submitBlocked = true; throw error; }
          await publish(draft);
          if (action) await command(action);
        }).catch(report);
      } else if (action) {
        // Local stop/hide controls must not wait for a slow append request.
        const ordered = action === "submit" || action === "clear" || action === "new-task";
        void (ordered ? enqueue(() => command(action)) : command(action)).catch(report);
      }
    } else if (event.type === "draft-action") {
      void (async () => {
        if (!drafts) throw new Error("История диктовки недоступна.");
        if (event.action === "clear") { await drafts.clear(); syncDrafts(); }
        else if (typeof event.id === "string") {
          if (event.action === "insert") await drafts.recover(recover, event.id);
          else if (event.action === "copy" || event.action === "view") {
            const draft = drafts.get(event.id);
            if (draft) send({ type: "draft-text", action: event.action, text: draft.text });
          }
        }
      })().catch(report);
    } else if (event.type === "error" && typeof event.message === "string") {
      diagnostic?.("native-error", { reason: "native-failed" }); report(event.message);
    }
    else if (event.type === "dictation") {
      void toast(event.active ? "Микрофон включён. Надиктуй текст, сделай паузу и скажи «Отправить»; кнопка завершает без отправки." : "Микрофон выключен.").catch(() => undefined);
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
      diagnostic?.("native-connect", { reason: "connected" });
      speech = new SpeechRouter(config, new LocalTts({ log, diagnostic }), send, log, undefined, {
        changed: (pending, speaker) => lifecycle.speechActivity(pending, speaker),
        voiceFor: (id, role) => lifecycle.voiceFor(id, role),
      }, diagnostic);
      syncDrafts(); lifecycle.replay();
    })().finally(() => { connection = undefined; });
    return connection;
  };
  try { await connect(); } catch (error) { log(String(error)); }
  const dispose = (): void => { disposed = true; lifecycle.dispose(); speech?.dispose(); host?.close(); };
  return {
    dispose: async () => { dispose(); await diagnostics?.flush(); },
    event: async ({ event }) => {
      if (disposed) return;
      if (event.type === "server.instance.disposed") { dispose(); await diagnostics?.flush(); }
      else director.event(event);
    },
    "chat.message": async (input, output) => {
      const task = output.parts.filter(part => part.type === "text" && !part.synthetic && !part.ignored)
        .map(part => part.type === "text" ? part.text : "").join("\n");
      director.assignTask(input.sessionID, { agent: input.agent ?? output.message.agent,
        task, messageID: output.message.id });
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const context = director.openingContext(input.sessionID);
      if (!context) return;
      try { output.system.push(await openings.instruction(context.role, context.agent)); }
      catch (error) { log(String(error)); }
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
      companion_intro: tool({
        description: "Speak one new, task-specific companion introduction. Never repeat it as a normal message. Returns duplicate for any previously spoken wording; continue the actual task after at most two retries.",
        args: { text: tool.schema.string().min(1).max(180) },
        async execute({ text: raw }, context) {
          const task = director.openingContext(context.sessionID);
          if (!task || context.abort?.aborted) return "skipped: no new active task introduction is needed";
          const text = spokenText(raw, config.maxSpeechLength);
          if (!/[\p{L}\p{N}]/u.test(text)) return "invalid: compose a short spoken introduction without markup";
          try {
            if (!await openings.claim(text)) return "duplicate: compose a different task-specific introduction";
            if (context.abort?.aborted || !director.introduce(context.sessionID, task.taskId, text)) return "skipped: task changed";
            return "queued: introduction accepted; continue the task without repeating it";
          } catch (error) { log(String(error)); return "unavailable: continue the task without an introduction"; }
        },
      }),
      companion: tool({
        description: "Control native macOS companions. Dictation is retained as local text drafts and submitted only after the user's spoken command. recover_dictation republishes the latest draft without submitting; OpenCode does not acknowledge insertion.",
        args: { action: tool.schema.enum(["preview", "hide", "show", "reset_position", "voice_menu", "test_voice", "mute", "unmute", "stop", "dictation_on", "dictation_off", "recover_dictation", "clear_dictation"]) },
        async execute({ action }) {
          if (action === "recover_dictation") {
            if (!drafts) throw new Error("История диктовки недоступна.");
            await drafts.recover(recover);
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
