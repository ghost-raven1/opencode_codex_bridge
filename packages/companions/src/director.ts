import { randomUUID } from "node:crypto";
import type { CompanionConfig, Role } from "./config.js";
import { appearanceFor } from "./presets.js";
import { detectRole, type TaskAssignment } from "./role-detection.js";
import { readCodexSpeech } from "./codex-speech.js";
import { stripSpeechCode } from "./speech-text.js";

export type State = "idle" | "thinking" | "working" | "success" | "error" | "waiting";
export interface CompanionEvent {
  type: "state" | "speak" | "stop" | "remove";
  characterId: string;
  taskId?: string;
  invocationId?: string;
  name?: string;
  runId?: string;
  voice?: string;
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
  assistantFinish?: string;
  activeTools: Set<string>;
  idleRequested: boolean;
  pending: Set<string>;
  aborted: boolean;
  agent?: string;
  parentID?: string;
  task?: string;
  taskMessageID?: string;
  taskParts: Map<string, string>;
  visible: boolean;
  taskId?: string;
  runId?: string;
  assigned: Map<string, TaskAssignment>;
  pendingUser?: string;
  pendingAgent?: string;
  compaction: boolean;
  continuation: boolean;
  runs: Map<string, { id: string; partId: string; messageId: string; snapshot: NonNullable<ReturnType<typeof readCodexSpeech>> }>;
  users: Set<string>;
  openingDone?: boolean;
  invocationId?: string;
  startedTask?: boolean;
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
  return stripSpeechCode(text).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ").replace(/[*#`_>]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Maps session activity to a bounded set of characters; global events never create characters. */
export class CompanionDirector {
  private sessions = new Map<string, Session>();
  private retired = new Set<string>();
  constructor(private config: CompanionConfig, private emit: (event: CompanionEvent) => void) {}

  private remove(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      for (const run of session.runs.values()) this.remove(run.id);
      if (session.visible) this.output(id, { type: "remove" });
      if (session.runId && session.parentID) this.sessions.get(session.parentID)?.runs.delete(session.runId);
      this.sessions.delete(id);
    }
    this.retired.add(id);
    if (this.retired.size > 128) this.retired.delete(this.retired.values().next().value!);
  }

  private session(id: string): Session {
    let entry = this.sessions.get(id);
    if (!entry) {
      if (this.sessions.size >= 128) this.remove(this.sessions.keys().next().value!);
      entry = { role: "coordinator", state: "idle", parts: new Map(), spoken: new Set(), pending: new Set(),
        invalidated: new Set(), assistantComplete: false, aborted: false, taskParts: new Map(), visible: false,
        assigned: new Map(), compaction: false, continuation: false, runs: new Map(), users: new Set(),
        activeTools: new Set(), idleRequested: false };
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
    const session = this.session(id);
    if (task.messageID && task.messageID !== session.lastUser) {
      session.assigned.set(task.messageID, task);
      if (session.assigned.size > 16) session.assigned.delete(session.assigned.keys().next().value!);
      return;
    }
    const previousAgent = session.agent;
    if (task.agent) session.agent = task.agent;
    if (task.parentID) session.parentID = task.parentID;
    if (task.parentID && !task.messageID) {
      const parent = this.sessions.get(task.parentID);
      // Metadata can arrive again after the child has started its own user message.
      session.taskId ??= parent?.taskId ?? parent?.lastUser ?? parent?.assistant ?? id;
    }
    session.task = task.task.slice(0, 16000);
    session.taskMessageID = task.messageID ?? session.lastUser;
    const role = this.taskRole(session);
    const changed = role !== session.role || previousAgent !== session.agent; session.role = role;
    if (task.parentID && !session.visible) this.state(id, "working");
    else if (changed && session.visible) this.state(id, session.state);
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
    if (role !== session.role) { session.role = role; if (session.visible) this.state(id, session.state); }
  }

  private output(id: string, event: Omit<CompanionEvent, "characterId">): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.emit({ characterId: id, ...(session.taskId ? { taskId: session.taskId } : {}),
      ...((event.type === "state" || event.type === "speak") && session.invocationId ? { invocationId: session.invocationId } : {}),
      ...(session.runId ? { runId: session.runId } : {}), ...event });
  }

  private state(id: string, state: State): void {
    const session = this.sessions.get(id)!;
    session.invocationId ??= randomUUID();
    session.state = state; session.visible = true;
    const appearance = appearanceFor(id, session.role, this.config.appearance, session.agent);
    this.output(id, { type: "state", role: session.role, state,
      appearance: { ...appearance, ...(session.runId ? { label: `CODEX · ${appearance.label}` } : {}) } });
  }

  private speak(id: string, text: string): void {
    const session = this.sessions.get(id)!, role = session.role;
    // The legacy setting names the primary speaker; its appearance can now change with the task.
    if (this.config.speech === "off" || (this.config.speech === "coordinator-only" && session.parentID)) return;
    const clean = spokenText(text, this.config.maxSpeechLength);
    if (clean) { session.openingDone = true; this.output(id, { type: "speak", role, text: clean }); }
  }

  /** Only a live, not-yet-speaking user task may request a generated introduction. */
  openingContext(id: string): { taskId: string; role: Role; agent?: string } | undefined {
    const session = this.sessions.get(id);
    if (!this.config.modelOpenings || this.config.workingPhrase || this.config.speech === "off" || !session ||
        session.openingDone || session.aborted || session.compaction || session.continuation || ["error", "success", "idle"].includes(session.state) ||
        (session.parentID && this.config.speech === "coordinator-only") || !session.taskId) return;
    return { taskId: session.taskId, role: session.role, ...(session.agent ? { agent: session.agent } : {}) };
  }

  /** Recheck task identity after the asynchronous history write so stale intros cannot return. */
  introduce(id: string, taskId: string, text: string): boolean {
    if (this.openingContext(id)?.taskId !== taskId) return false;
    const clean = spokenText(text, this.config.maxSpeechLength);
    if (!/[\p{L}\p{N}]/u.test(clean)) return false;
    this.speak(id, clean);
    return true;
  }

  private stopRuns(id: string): void {
    const session = this.sessions.get(id)!;
    for (const run of session.runs.values()) this.remove(run.id);
    session.runs.clear();
  }

  /** A real user input starts a new task; synthetic continuations only replace the wire parent. */
  private beginTask(id: string, messageId: string, assignment?: TaskAssignment): void {
    const session = this.sessions.get(id)!;
    this.invalidate(session, session.assistant); this.stopRuns(id);
    this.output(id, { type: "stop" });
    // A child may appear from parent metadata before its first own user message.
    if (session.startedTask) session.invocationId = randomUUID();
    else session.invocationId ??= randomUUID();
    session.startedTask = true;
    const inherited = !session.taskId && session.taskMessageID === undefined && !!session.parentID;
    session.task = assignment?.task.slice(0, 16000) ?? (inherited ? session.task : undefined);
    session.agent = assignment?.agent ?? session.pendingAgent ?? session.agent;
    session.parentID = assignment?.parentID ?? session.parentID;
    session.taskMessageID = messageId; session.taskId = messageId; session.pendingUser = undefined;
    session.compaction = false; session.continuation = false; session.taskParts.clear();
    session.parts.clear(); session.assistant = undefined; session.assistantComplete = false;
    session.assistantFinish = undefined; session.activeTools.clear(); session.idleRequested = false;
    session.pending.clear(); session.aborted = false; session.spoken.clear();
    session.openingDone = false;
    session.role = this.taskRole(session); this.state(id, "thinking");
    if (!session.parentID) this.speak(id, this.config.workingPhrase);
  }

  private failure(id: string, error: ObjectValue): void {
    const session = this.sessions.get(id)!;
    if (session.state === "error" || (session.aborted && error.name === "MessageAbortedError")) return;
    this.output(id, { type: "stop" }); this.stopRuns(id);
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

  /** The task tool's return is authoritative even when its child's stream was missed. */
  completeTask(id: string): void {
    if (this.sessions.has(id)) this.idle(id, true);
  }

  private idle(id: string, completedTask = false): void {
    const session = this.sessions.get(id)!;
    // A queued idle event cannot dismiss approval, failure, or a user's cancellation.
    if (!session.visible || session.pending.size || session.state === "error" || session.aborted) return;
    session.idleRequested = true;
    // Idle has no message/task ID: an older notification can arrive during a new turn.
    if (!completedTask && (session.activeTools.size || !session.assistantComplete ||
      ["tool-calls", "unknown"].includes(session.assistantFinish ?? ""))) return;
    session.idleRequested = false;
    this.state(id, session.assistant ? "success" : "idle");
    this.flushSpeech(id, true);
  }

  private flushRuns(id: string): void {
    const parent = this.sessions.get(id)!;
    for (const run of parent.runs.values()) {
      const child = this.sessions.get(run.id), snapshot = run.snapshot;
      if (!child || child.aborted || child.state === "error") continue;
      if (snapshot.state === "interrupted" || snapshot.state === "failed") {
        this.output(run.id, { type: "stop" }); child.aborted = snapshot.state === "interrupted";
        this.state(run.id, child.aborted ? "idle" : "error"); continue;
      }
      const state = parent.pending.size ? "waiting" : snapshot.state === "completed" ? "success" : "working";
      if (!child.visible || child.state !== state) this.state(run.id, state);
      if (parent.pending.size || parent.aborted) continue;
      for (const message of snapshot.messages) {
        if (!message.text.trim() || child.spoken.has(message.messageId)) continue;
        child.spoken.add(message.messageId); this.speak(run.id, message.text);
      }
    }
  }

  private codexPart(id: string, part: ObjectValue): void {
    const parent = this.sessions.get(id)!, toolState = object(part.state);
    const snapshot = readCodexSpeech(object(toolState.metadata).codexSpeech);
    const partId = string(part.id), messageId = string(part.messageID);
    if (!snapshot || !partId || messageId !== parent.assistant || parent.aborted) return;
    let run = parent.runs.get(snapshot.runId);
    if (!run) {
      const characterId = `codex:${id}:${snapshot.runId}`;
      if (this.retired.has(characterId)) return;
      const child = this.session(characterId);
      child.parentID = id; child.taskId = parent.taskId ?? parent.lastUser ?? messageId; child.runId = snapshot.runId;
      child.task = string(object(toolState.input).prompt); child.agent = "codex"; child.role = this.taskRole(child);
      run = { id: characterId, partId, messageId, snapshot }; parent.runs.set(snapshot.runId, run);
    } else if (run.partId !== partId || run.messageId !== messageId || run.snapshot.state !== "running") return;
    run.snapshot = snapshot; this.flushRuns(id);
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
    const session = this.session(id);
    if (type === "message.updated" && info.role === "assistant" &&
      (info.summary === true || info.mode === "compaction" || info.agent === "compaction")) {
      const messageId = string(info.id);
      this.invalidate(session, messageId); session.compaction = true;
      session.assistantComplete = false; session.idleRequested = false;
      for (const [key, value] of session.parts) if (value.messageId === messageId) session.parts.delete(key);
      return;
    }
    if (sessionEvent) {
      if (typeof info.parentID === "string") session.parentID = info.parentID;
      const role = this.taskRole(session);
      if (role !== session.role) { session.role = role; if (session.visible) this.state(id, session.state); }
    } else if (type === "message.updated") {
      const messageId = string(info.id);
      if (!messageId) return;
      if (info.role === "user" && session.lastUser !== messageId) {
        if (session.users.has(messageId)) return;
        session.users.add(messageId);
        if (session.users.size > 128) session.users.delete(session.users.values().next().value!);
        const assignment = session.assigned.get(messageId); session.assigned.delete(messageId);
        session.lastUser = messageId; session.pendingUser = messageId;
        session.pendingAgent = string(info.agent ?? info.mode) || session.agent;
        session.continuation = session.compaction && !assignment;
        if (assignment) this.beginTask(id, messageId, assignment);
      } else if (info.role === "assistant") {
        if (session.aborted || session.invalidated.has(messageId) ||
          (session.lastUser && typeof info.parentID === "string" && info.parentID !== session.lastUser)) return;
        const fresh = session.assistant !== messageId;
        if (fresh) {
          this.invalidate(session, session.assistant);
          session.assistantComplete = false;
          session.assistantFinish = undefined; session.idleRequested = false; session.activeTools.clear();
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
          if (typeof object(info.time).completed === "number") {
            session.assistantComplete = true; session.assistantFinish = string(info.finish);
          }
          this.flushSpeech(id);
          if (session.idleRequested) this.idle(id);
        }
      }
    } else if (type === "message.part.updated") {
      const partId = string(part.id), messageId = string(part.messageID);
      if (session.invalidated.has(messageId)) return;
      if (part.type === "compaction" && messageId === session.lastUser) {
        session.compaction = true; session.continuation = true; return;
      }
      if (part.type === "tool" && (session.aborted || (messageId && messageId !== session.assistant))) return;
      if (part.type === "tool" && partId) {
        const status = object(part.state).status;
        if (status === "running" || status === "pending") session.activeTools.add(partId);
        else if (status === "completed" || status === "error") session.activeTools.delete(partId);
      }
      if (part.type === "tool" && part.tool === "task") {
        const toolState = object(part.state), metadata = object(toolState.metadata), input = object(toolState.input);
        const childId = string(metadata.sessionId);
        const task = [string(input.description), string(input.prompt)].filter(Boolean).join("\n");
        if (childId && childId !== id && task) this.assignTask(childId, { parentID: id, agent: string(input.subagent_type), task });
      }
      if (part.type === "tool" && part.tool === "codex") this.codexPart(id, part);
      if (messageId === session.lastUser && (part.type === "text" || part.type === "file")) {
        if (part.ignored || part.synthetic || session.continuation) return;
        if (session.pendingUser === messageId) this.beginTask(id, messageId, {
          task: string(part.text) || session.task || "", agent: session.pendingAgent, parentID: session.parentID,
        });
        if (part.type === "text" && partId && typeof part.text === "string") this.updateTaskPart(id, partId, part.text);
      } else if (part.type === "text" && partId && messageId) {
        if (part.ignored || part.synthetic) session.parts.delete(partId);
        else if (typeof part.text === "string") {
          // Clean the full part before capping it so a truncated closing fence cannot expose code.
          session.parts.set(partId, { messageId, text: spokenText(part.text, this.config.maxSpeechLength * 2),
            complete: typeof object(part.time).end === "number" });
          if (session.parts.size > 128) session.parts.delete(session.parts.keys().next().value!);
          this.flushSpeech(id);
        }
      } else if (!session.pending.size && session.state !== "error" && !session.aborted) {
        if (part.type === "tool") this.state(id, "working");
        else if (part.type === "reasoning") this.state(id, "thinking");
      }
      if (session.idleRequested) this.idle(id);
    } else if (type === "message.part.removed") {
      const partId = string(props.partID);
      session.activeTools.delete(partId);
      session.parts.delete(partId);
      if (session.taskParts.has(partId)) this.updateTaskPart(id, partId);
      for (const [runId, run] of session.runs) if (run.partId === partId) { this.remove(run.id); session.runs.delete(runId); }
    }
    else if (type === "message.removed") {
      const messageId = string(props.messageID);
      this.invalidate(session, messageId);
      for (const [key, value] of session.parts) if (value.messageId === messageId) session.parts.delete(key);
      for (const [runId, run] of session.runs) if (run.messageId === messageId) { this.remove(run.id); session.runs.delete(runId); }
      if (session.assistant === messageId) { session.assistant = undefined; this.output(id, { type: "stop" }); }
    } else if (type === "session.error") this.failure(id, object(props.error));
    else if (type === "permission.updated" || type.endsWith(".asked")) {
      const kind = type.startsWith("permission") ? "permission" : "question";
      session.pending.add(`${kind}:${string(props.id)}`);
      if (session.pending.size > 32) session.pending.delete(session.pending.values().next().value!);
      this.output(id, { type: "stop" }); this.state(id, "waiting");
      for (const run of session.runs.values()) this.output(run.id, { type: "stop" });
      this.flushRuns(id);
    } else if (type.endsWith(".replied") || type === "question.rejected") {
      const kind = type.startsWith("permission") ? "permission" : "question";
      session.pending.delete(`${kind}:${string(props.requestID ?? props.permissionID ?? props.id)}`);
      if (!session.pending.size && session.state === "waiting") this.state(id, "thinking");
      this.flushSpeech(id);
      this.flushRuns(id);
    } else if (type === "session.idle" || (type === "session.status" && object(props.status).type === "idle")) this.idle(id);
    else if (type === "session.status" && !session.pending.size && !session.aborted && session.state !== "error") {
      session.idleRequested = false;
      this.state(id, session.activeTools.size ? "working" : "thinking");
    }
  }
}
