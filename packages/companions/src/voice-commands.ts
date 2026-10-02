import type { PluginInput } from "@opencode-ai/plugin";

export const voiceCommands = ["submit", "clear", "cancel", "stop-speech", "stop-task", "hide", "show",
  "new-task", "mute", "unmute", "disable-dictation", "help"] as const;
export type VoiceCommand = typeof voiceCommands[number];

/** Only native allow-listed command identifiers may invoke CLI actions. */
export function isVoiceCommand(value: unknown): value is VoiceCommand {
  return typeof value === "string" && (voiceCommands as readonly string[]).includes(value);
}

/** HTTP success acknowledges an event; the TUI does not confirm its application. */
export async function executeVoiceCommand(command: VoiceCommand, client: PluginInput["client"], directory: string,
  send: (event: object) => void): Promise<void> {
  const options = { query: { directory }, signal: AbortSignal.timeout(5000) };
  if (command === "submit" || command === "clear" || command === "stop-task" || command === "new-task") {
    const result = command === "submit" ? await client.tui.submitPrompt(options)
      : command === "clear" ? await client.tui.clearPrompt(options)
      : await client.tui.executeCommand({ ...options, body: { command: command === "stop-task" ? "session.interrupt" : "session.new" } });
    if (result.error) throw new Error("Не удалось передать голосовую команду в CLI. Проверь подключение OpenCode.");
    return;
  }
  const events: Record<Exclude<VoiceCommand, "submit" | "clear" | "stop-task" | "new-task">, object> = {
    cancel: { type: "dictation-cancel" }, "stop-speech": { type: "stop-speech" },
    hide: { type: "hide" }, show: { type: "show" }, mute: { type: "mute", muted: true }, unmute: { type: "mute", muted: false },
    "disable-dictation": { type: "dictation-disable" }, help: { type: "voice-help" },
  };
  send(events[command]);
}
