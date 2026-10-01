import type { CompanionConfig, Role } from "./config.js";
import { appearanceFor } from "./presets.js";
import { detectRole, type TaskAssignment } from "./role-detection.js";

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
  parts: Map<string, { messageId: string; text: string; complete: boolean }>;
  spoken: Set<string>;
  invalidated: Set<string>;
  assistantComplete: boolean;
  pending: Set<string>;
  aborted: boolean;
  agent?: string;
  parentID?: string;
  task?: string;
  taskMessageID?: string;
  taskParts: Map<string, string>;
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
      entry = { role: "coordinator", state: "idle", parts: new Map(), spoken: new Set(), pending: new Set(),
        invalidated: new Set(), assistantComplete: false, aborted: false, taskParts: new Map() };
      this.sessions.set(id, entry);
    }
    // Evict least recently active sessions, rather than active sessions created first.
    this.sessions.delete(id); this.sessions.set(id, entry);
    return entry;
  }

  /** Assign the original user/subagent task before streaming starts or when a child ID becomes known. */
  assignTask(id: string, task: TaskAssignment): void {
    if (!id) return;
    this.retired.delete(id);
    const existed = this.sessions.has(id), session = this.session(id);
    if (task.agent) session.agent = task.agent;
    if (task.parentID) session.parentID = task.parentID;
    session.task = task.task.slice(0, 16000);
    session.taskMessageID = task.messageID ?? session.lastUser;
    const role = this.taskRole(session);
    if (!existed || role !== session.role) { session.role = role; this.state(id, session.state); }
  }

  private taskRole(session: Session): Role {
    return detectRole({ agent: session.agent, task: session.task ?? "", parentID: session.parentID }, this.config.agentRoles);
  }

  private updateTaskPart(id: string, partId: string, text?: string): void {
    const session = this.sessions.get(id)!;
    if (text === undefined) session.taskParts.delete(partId);
    else session.taskParts.set(partId, text.slice(0, 16000));
    if (session.taskParts.size > 32) session.taskParts.delete(session.taskParts.keys().next().value!);
    session.task = [...session.taskParts.values()].join("\n").slice(0, 16000);
    const role = this.taskRole(session);
    if (role !== session.role) { session.role = role; this.state(id, session.state); }
  }

  private state(id: string, state: State): void {
    const session = this.sessions.get(id)!;
    session.state = state;
    this.emit({ type: "state", characterId: id, role: session.role, state,
      appearance: appearanceFor(id, session.role, this.config.appearance) });
  }

  private speak(id: string, text: string): void {
    const session = this.sessions.get(id)!, role = session.role;
    // The legacy setting names the primary speaker; its appearance can now change with the task.
    if (this.config.speech === "off" || (this.config.speech === "coordinator-only" && session.parentID)) return;
    const clean = spokenText(text, this.config.maxSpeechLength);
    if (clean) this.emit({ type: "speak", characterId: id, role, text: clean });
  }

  private failure(id: string, error: ObjectValue): void {
    const session = this.sessions.get(id)!;
    if (session.state === "error" || (session.aborted && error.name === "MessageAbortedError")) return;
    this.emit({ type: "stop", characterId: id });
    this.invalidate(session, session.assistant);
    session.pending.clear(); session.parts.clear();
    session.aborted = error.name === "MessageAbortedError";
    this.state(id, session.aborted ? "idle" : "error");
    if (!session.aborted) this.speak(id, "В задаче возникла ошибка. Подробности в терминале.");
  }

  private invalidate(session: Session, messageId?: string): void {
    if (!messageId) return;
    session.invalidated.add(messageId);
    if (session.invalidated.size > 128) session.invalidated.delete(session.invalidated.values().next().value!);
  }

  /** OpenCode 1.3.2 commits text-end with TextPart.time.end, before tools or session idle. */
  private flushSpeech(id: string, completedMessage = false): void {
    const session = this.sessions.get(id)!;
    if (!session.assistant || session.pending.size || session.state === "error" || session.aborted) return;
    const parts = [...session.parts].filter(([partId, part]) => part.messageId === session.assistant &&
      part.text.trim() && !session.spoken.has(partId) && (part.complete || session.assistantComplete || completedMessage));
    if (!parts.length) return;
    for (const [partId] of parts) session.spoken.add(partId);
    while (session.spoken.size > 256) session.spoken.delete(session.spoken.values().next().value!);
    this.speak(id, parts.map(([, part]) => part.text).join(" "));
  }

  private idle(id: string): void {
    const session = this.sessions.get(id)!;
    // A queued idle event cannot dismiss approval, failure, or a user's cancellation.
    if (session.pending.size || session.state === "error" || session.aborted) return;
    this.state(id, session.assistant ? "success" : "idle");
    this.flushSpeech(id, true);
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
      if (typeof info.parentID === "string") session.parentID = info.parentID;
      const role = this.taskRole(session);
      if (!existing || role !== session.role) { session.role = role; this.state(id, session.state); }
    } else if (type === "message.updated") {
      const messageId = string(info.id);
      if (!messageId) return;
      if (info.role === "user" && session.lastUser !== messageId) {
        this.invalidate(session, session.assistant);
        const assigned = session.taskMessageID === messageId || (session.taskMessageID === undefined && !session.lastUser);
        if (!assigned) session.task = undefined;
        session.taskMessageID = messageId; session.taskParts.clear();
        session.lastUser = messageId;
        session.parts.clear(); session.assistant = undefined; session.assistantComplete = false;
        session.pending.clear(); session.aborted = false;
        this.emit({ type: "stop", characterId: id });
        session.agent = string(info.agent ?? info.mode) || session.agent;
        session.role = this.taskRole(session);
        this.state(id, "thinking");
        this.speak(id, this.config.workingPhrase);
      } else if (info.role === "assistant") {
        if (session.aborted || session.invalidated.has(messageId) ||
          (session.lastUser && typeof info.parentID === "string" && info.parentID !== session.lastUser)) return;
        const fresh = session.assistant !== messageId;
        if (fresh) {
          this.invalidate(session, session.assistant);
          session.assistantComplete = false;
          for (const [key, value] of session.parts) if (value.messageId !== messageId) session.parts.delete(key);
        }
        session.assistant = messageId;
        // Assistant output and its selected model/mode cannot relabel an already assigned task.
        if (!session.lastUser && session.task === undefined && !session.agent) {
          session.agent = string(info.agent ?? info.mode); session.role = this.taskRole(session);
        }
        if (info.error) this.failure(id, object(info.error));
        else {
          if (fresh && !session.pending.size) this.state(id, "thinking");
          if (typeof object(info.time).completed === "number") session.assistantComplete = true;
          this.flushSpeech(id);
        }
      }
    } else if (type === "message.part.updated") {
      const partId = string(part.id), messageId = string(part.messageID);
      if (session.invalidated.has(messageId)) return;
      if (part.type === "tool" && part.tool === "task") {
        const toolState = object(part.state), metadata = object(toolState.metadata), input = object(toolState.input);
        const childId = string(metadata.sessionId);
        const task = [string(input.description), string(input.prompt)].filter(Boolean).join("\n");
        if (childId && childId !== id && task) this.assignTask(childId, { parentID: id, agent: string(input.subagent_type), task });
      }
      if (part.type === "text" && partId && messageId === session.lastUser) {
        this.updateTaskPart(id, partId, !part.ignored && !part.synthetic && typeof part.text === "string" ? part.text : undefined);
      } else if (part.type === "text" && partId && messageId) {
        if (part.ignored || part.synthetic) session.parts.delete(partId);
        else if (typeof part.text === "string") {
          session.parts.set(partId, { messageId, text: part.text.slice(0, this.config.maxSpeechLength * 2),
            complete: typeof object(part.time).end === "number" });
          if (session.parts.size > 128) session.parts.delete(session.parts.keys().next().value!);
          this.flushSpeech(id);
        }
      } else if (!session.pending.size && session.state !== "error" && !session.aborted) {
        if (part.type === "tool") this.state(id, "working");
        else if (part.type === "reasoning") this.state(id, "thinking");
      }
    } else if (type === "message.part.removed") {
      const partId = string(props.partID);
      session.parts.delete(partId);
      if (session.taskParts.has(partId)) this.updateTaskPart(id, partId);
    }
    else if (type === "message.removed") {
      const messageId = string(props.messageID);
      this.invalidate(session, messageId);
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
      this.flushSpeech(id);
    } else if (type === "session.idle" || (type === "session.status" && object(props.status).type === "idle")) this.idle(id);
    else if (type === "session.status" && !session.pending.size && !session.aborted) this.state(id, "thinking");
  }
}
