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
  spoken: Set<string>;
  pending: Set<string>;
  aborted: boolean;
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" ? value as ObjectValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const tracked = new Set([
  "session.created", "session.updated", "session.deleted", "session.error", "session.status", "session.idle",
  "message.updated", "message.removed", "message.part.updated", "message.part.removed",
  "permission.updated", "permission.asked", "permission.replied", "question.asked", "question.replied", "question.rejected",
]);

/** Remove code/URLs from speech without changing the original terminal message. */
export function spokenText(text: string, maxLength: number): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ").replace(/[*#`_>]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Maps session activity to a bounded set of characters; global events never create characters. */
export class CompanionDirector {
  private sessions = new Map<string, Session>();
  private retired = new Set<string>();
  constructor(private config: CompanionConfig, private emit: (event: CompanionEvent) => void) {}

  private remove(id: string): void {
    if (this.sessions.delete(id)) this.emit({ type: "remove", characterId: id });
    this.retired.add(id);
    if (this.retired.size > 128) this.retired.delete(this.retired.values().next().value!);
  }

  private session(id: string): Session {
    let entry = this.sessions.get(id);
    if (!entry) {
      if (this.sessions.size >= 128) this.remove(this.sessions.keys().next().value!);
      entry = { role: "coordinator", state: "idle", parts: new Map(), spoken: new Set(), pending: new Set(), aborted: false };
      this.sessions.set(id, entry);
    }
    // Evict least recently active sessions, rather than active sessions created first.
    this.sessions.delete(id); this.sessions.set(id, entry);
    return entry;
  }

  private state(id: string, state: State): void {
    const session = this.sessions.get(id)!;
    session.state = state;
    this.emit({ type: "state", characterId: id, role: session.role, state,
      appearance: appearanceFor(id, session.role, this.config.appearance) });
  }

  private speak(id: string, text: string): void {
    const role = this.sessions.get(id)!.role;
    if (this.config.speech === "off" || (this.config.speech === "coordinator-only" && role !== "coordinator")) return;
    const clean = spokenText(text, this.config.maxSpeechLength);
    if (clean) this.emit({ type: "speak", characterId: id, role, text: clean });
  }

  private failure(id: string, error: ObjectValue): void {
    const session = this.sessions.get(id)!;
    if (session.state === "error" || (session.aborted && error.name === "MessageAbortedError")) return;
    this.emit({ type: "stop", characterId: id });
    session.pending.clear(); session.parts.clear();
    session.aborted = error.name === "MessageAbortedError";
    this.state(id, session.aborted ? "idle" : "error");
    if (!session.aborted) this.speak(id, "В задаче возникла ошибка. Подробности в терминале.");
  }

  private idle(id: string): void {
    const session = this.sessions.get(id)!;
    // A queued idle event cannot dismiss approval, failure, or a user's cancellation.
    if (session.pending.size || session.state === "error" || session.aborted) return;
    this.state(id, session.assistant ? "success" : "idle");
    if (!session.assistant || session.spoken.has(session.assistant)) return;
    const text = [...session.parts.values()].filter(p => p.messageId === session.assistant).map(p => p.text).join(" ");
    if (!text) return;
    session.spoken.add(session.assistant);
    if (session.spoken.size > 64) session.spoken.delete(session.spoken.values().next().value!);
    this.speak(id, text);
  }

  event(input: unknown): void {
    const event = object(input), type = string(event.type);
    if (!tracked.has(type)) return;
    const props = object(event.properties), info = object(props.info), part = object(props.part);
    const sessionEvent = ["session.created", "session.updated", "session.deleted"].includes(type);
    const id = string(sessionEvent ? info.id : props.sessionID ?? info.sessionID ?? part.sessionID);
    if (!id) return;
    if (type === "session.deleted" || (sessionEvent && object(info.time).archived)) { this.remove(id); return; }
    const resume = type === "session.created" || type === "session.updated" || (type === "message.updated" && info.role === "user");
    if (resume) this.retired.delete(id);
    else if (this.retired.has(id)) return;
    // Ignore delayed parts and idle/reply notifications for sessions no longer tracked.
    if (!this.sessions.has(id) && (type.includes(".removed") || type === "message.part.updated" ||
      type === "session.idle" || (type === "session.status" && object(props.status).type === "idle") ||
      type.endsWith(".replied") || type === "question.rejected")) return;
    const existing = this.sessions.has(id);
    const session = this.session(id);
    if (sessionEvent) {
      if (!existing) { session.role = info.parentID ? "developer" : "coordinator"; this.state(id, "idle"); }
    } else if (type === "message.updated") {
      const messageId = string(info.id);
      if (!messageId) return;
      if (info.role === "user" && session.lastUser !== messageId) {
        session.lastUser = messageId;
        session.parts.clear(); session.assistant = undefined; session.pending.clear(); session.aborted = false;
        this.emit({ type: "stop", characterId: id });
        const role = this.config.agentRoles[string(info.agent ?? info.mode)];
        if (role) session.role = role;
        this.state(id, "thinking");
        this.speak(id, this.config.workingPhrase);
      } else if (info.role === "assistant") {
        const fresh = session.assistant !== messageId;
        if (fresh) {
          for (const [key, value] of session.parts) if (value.messageId !== messageId) session.parts.delete(key);
        }
        session.assistant = messageId;
        const role = this.config.agentRoles[string(info.agent ?? info.mode)];
        if (role) session.role = role;
        if (info.error) this.failure(id, object(info.error));
        else if (fresh) {
          session.aborted = false;
          if (!session.pending.size) this.state(id, "thinking");
        }
      }
    } else if (type === "message.part.updated") {
      const partId = string(part.id), messageId = string(part.messageID);
      if (part.type === "text" && partId && messageId && messageId !== session.lastUser) {
        if (part.ignored || part.synthetic) session.parts.delete(partId);
        else if (typeof part.text === "string") {
          session.parts.set(partId, { messageId, text: part.text.slice(0, this.config.maxSpeechLength * 2) });
          if (session.parts.size > 128) session.parts.delete(session.parts.keys().next().value!);
        }
      } else if (!session.pending.size && session.state !== "error" && !session.aborted) {
        if (part.type === "tool") this.state(id, "working");
        else if (part.type === "reasoning") this.state(id, "thinking");
      }
    } else if (type === "message.part.removed") session.parts.delete(string(props.partID));
    else if (type === "message.removed") {
      const messageId = string(props.messageID);
      for (const [key, value] of session.parts) if (value.messageId === messageId) session.parts.delete(key);
      if (session.assistant === messageId) { session.assistant = undefined; this.emit({ type: "stop", characterId: id }); }
    } else if (type === "session.error") this.failure(id, object(props.error));
    else if (type === "permission.updated" || type.endsWith(".asked")) {
      const kind = type.startsWith("permission") ? "permission" : "question";
      session.pending.add(`${kind}:${string(props.id)}`);
      if (session.pending.size > 32) session.pending.delete(session.pending.values().next().value!);
      this.emit({ type: "stop", characterId: id }); this.state(id, "waiting");
    } else if (type.endsWith(".replied") || type === "question.rejected") {
      const kind = type.startsWith("permission") ? "permission" : "question";
      session.pending.delete(`${kind}:${string(props.requestID ?? props.permissionID ?? props.id)}`);
      if (!session.pending.size && session.state === "waiting") this.state(id, "thinking");
    } else if (type === "session.idle" || (type === "session.status" && object(props.status).type === "idle")) this.idle(id);
    else if (type === "session.status" && !session.pending.size && !session.aborted) this.state(id, "thinking");
  }
}
