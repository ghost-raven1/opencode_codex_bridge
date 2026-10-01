import type { CompanionConfig, Role } from "./config.js";
import { appearanceFor } from "./presets.js";

export type State = "idle" | "thinking" | "working" | "success" | "error" | "waiting";
export interface CompanionEvent {
  type: "state" | "speak" | "stop" | "remove";
  characterId: string;
  role?: Role;
  appearance?: ReturnType<typeof appearanceFor>;
  state?: State;
  text?: string;
}
interface Session {
  role: Role;
  state: State;
  lastUser?: string;
  assistant?: string;
  parts: Map<string, { messageId: string; text: string }>;
  spoken?: string;
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" ? value as ObjectValue : {};

/** Remove code/URLs from speech without changing the original terminal message. */
export function spokenText(text: string, maxLength: number): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ").replace(/[*#`_>]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Converts real session events into bounded character state and one shared speech queue. */
export class CompanionDirector {
  private sessions = new Map<string, Session>();
  constructor(private config: CompanionConfig, private emit: (event: CompanionEvent) => void) {}

  private session(id: string): Session {
    let entry = this.sessions.get(id);
    if (!entry) {
      if (this.sessions.size >= 128) {
        const oldest = this.sessions.keys().next().value!;
        this.sessions.delete(oldest); this.emit({ type: "remove", characterId: oldest });
      }
      entry = { role: "coordinator", state: "idle", parts: new Map() };
      this.sessions.set(id, entry);
    }
    return entry;
  }

  private state(id: string, state: State): void {
    const session = this.session(id);
    session.state = state;
    this.emit({ type: "state", characterId: id, role: session.role, state, appearance: appearanceFor(id, session.role) });
  }

  private speak(id: string, text: string): void {
    const role = this.session(id).role;
    if (this.config.speech === "off" || (this.config.speech === "coordinator-only" && role !== "coordinator")) return;
    const clean = spokenText(text, this.config.maxSpeechLength);
    if (clean) this.emit({ type: "speak", characterId: id, role, text: clean });
  }

  event(input: unknown): void {
    const event = object(input), props = object(event.properties), info = object(props.info), part = object(props.part);
    const id = String(props.sessionID ?? info.sessionID ?? part.sessionID ?? info.id ?? "");
    if (!id) return;
    if (event.type === "session.deleted") {
      this.sessions.delete(id); this.emit({ type: "remove", characterId: id }); return;
    }
    const session = this.session(id);
    if (event.type === "session.created") {
      session.role = info.parentID ? "developer" : "coordinator";
      this.state(id, "idle");
    } else if (event.type === "message.updated") {
      if (info.role === "user" && session.lastUser !== info.id) {
        session.lastUser = String(info.id);
        session.parts.clear(); session.assistant = undefined; session.spoken = undefined;
        this.emit({ type: "stop", characterId: id });
        const role = this.config.agentRoles[String(info.agent ?? "")];
        if (role) session.role = role;
        this.state(id, "thinking");
        this.speak(id, this.config.workingPhrase);
      } else if (info.role === "assistant") {
        session.assistant = String(info.id);
        const role = this.config.agentRoles[String(info.agent ?? info.mode ?? "")];
        if (role) session.role = role;
      }
    } else if (event.type === "message.part.updated") {
      if (part.type === "text" && typeof part.text === "string" && !part.ignored) {
        session.parts.set(String(part.id), { messageId: String(part.messageID), text: part.text.slice(0, this.config.maxSpeechLength * 2) });
        if (session.parts.size > 128) session.parts.delete(session.parts.keys().next().value!);
      } else if (part.type === "tool") this.state(id, "working");
      else if (part.type === "reasoning") this.state(id, "thinking");
    } else if (event.type === "session.error") {
      this.state(id, "error"); this.speak(id, "В задаче возникла ошибка. Подробности в терминале.");
    } else if (event.type === "permission.updated" || event.type === "permission.asked" || event.type === "question.asked") {
      this.state(id, "waiting");
    } else if (event.type === "session.idle" || (event.type === "session.status" && object(props.status).type === "idle")) {
      // OpenCode emits both idle forms; only speak each assistant message once.
      if (session.state !== "error") this.state(id, "success");
      if (session.assistant && session.spoken !== session.assistant) {
        const text = [...session.parts.values()].filter(p => p.messageId === session.assistant).map(p => p.text).join(" ");
        if (text) { session.spoken = session.assistant; this.speak(id, text); }
      }
    } else if (event.type === "session.status") this.state(id, "thinking");
  }
}
