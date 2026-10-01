import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CodexConnection } from "./connection.js";
import { answerRequest } from "./approvals.js";
import type { CodexSpeech, RpcMessage, RunOptions, RunResult } from "./types.js";

const threadSchema = z.object({ thread: z.object({ id: z.string(), cwd: z.string().optional() }) });
const turnSchema = z.object({ turn: z.object({ id: z.string() }) });
const activeThreads = new Set<string>();

/** Run one Codex turn inside the host project, retaining an explicit resumable thread id. */
export async function runCodex(options: RunOptions): Promise<RunResult> {
  options.signal?.throwIfAborted();
  if (!options.prompt.trim()) throw new Error("Prompt must not be empty");
  const cwd = await realpath(options.cwd);
  options.signal?.throwIfAborted();
  if (options.threadId && activeThreads.has(options.threadId)) throw new Error("This Codex thread already has an active turn");
  const connection = new CodexConnection(options.command, options.commandArgs);
  if (options.threadId) activeThreads.add(options.threadId);
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.timeoutMs ?? 30 * 60_000),
  ]);
  let threadId = "", turnId = "";
  let resolveDone!: (value: RunResult) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<RunResult>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  void done.catch(() => undefined);
  const texts = new Map<string, string>();
  const completed = new Map<string, CodexSpeech["messages"][number]>();
  const runId = randomUUID();
  let receivedBytes = 0, textBytes = 0, speechState: CodexSpeech["state"] = "running";
  const snapshot = (): CodexSpeech => ({ runId, threadId, messages: [...completed.values()], state: speechState });
  const publish = (): void => { if (threadId) options.onSpeech?.(snapshot()); };
  const setText = (id: string, text: string): void => {
    const bytes = textBytes - Buffer.byteLength(texts.get(id) ?? "") + Buffer.byteLength(text);
    if (bytes > 4 * 1024 * 1024 || (!texts.has(id) && texts.size >= 256)) throw new Error("Codex text output exceeded its limit (4 MiB / 256 messages)");
    textBytes = bytes; texts.set(id, text);
  };
  const fail = (error: Error): void => { rejectDone(error); };
  const abort = (): void => {
    fail(new Error("Codex request cancelled or timed out; inspect changes before retrying"));
    // Interrupt is best effort; closing/reaping the process is the final cancellation barrier.
    if (threadId && turnId) void connection.call("turn/interrupt", { threadId, turnId }, 1000).catch(() => undefined);
    void connection.close();
  };
  connection.on("failure", fail);
  signal.addEventListener("abort", abort, { once: true });
  connection.on("message", (message: RpcMessage) => {
    const p = message.params ?? {};
    if (p.threadId && p.threadId !== threadId) return;
    if (p.turnId && turnId && p.turnId !== turnId) return;
    if (message.id !== undefined) {
      void answerRequest(connection, message, options.approve).catch(fail); return;
    }
    if (speechState !== "running") return;
    try {
      if (message.method === "turn/started") {
        turnId = turnSchema.parse(p).turn.id;
      } else if (message.method === "item/agentMessage/delta") {
        const delta = z.object({ itemId: z.string(), delta: z.string() }).parse(p);
        receivedBytes += Buffer.byteLength(delta.delta);
        if (receivedBytes > 4 * 1024 * 1024) throw new Error("Codex text output exceeded 4 MiB");
        if (completed.has(delta.itemId)) return;
        setText(delta.itemId, (texts.get(delta.itemId) ?? "") + delta.delta);
        options.onText?.(delta.delta);
      } else if (message.method === "item/completed") {
        const item = z.object({ type: z.string(), id: z.string(), text: z.string().optional(), phase: z.string().nullable().optional() }).parse(p.item);
        if (item.type === "agentMessage" && item.text !== undefined && !completed.has(item.id) &&
          (item.phase == null || item.phase === "commentary" || item.phase === "final_answer")) {
          setText(item.id, item.text);
          completed.set(item.id, { messageId: item.id, text: item.text, state: "completed" });
          publish();
        }
      } else if (message.method === "turn/completed") {
        const turn = z.object({ id: z.string(), status: z.enum(["completed", "failed", "interrupted"]),
          error: z.object({ message: z.string() }).nullable().optional() }).parse(p.turn);
        if (turnId && turn.id !== turnId) return;
        speechState = turn.status; publish();
        resolveDone({ threadId, turnId: turn.id, status: turn.status, codexSpeech: snapshot(),
          text: [...texts.values()].join("\n\n"), ...(turn.error ? { error: turn.error.message } : {}) });
      }
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  try {
    await connection.initialize();
    signal.throwIfAborted();
    if (options.threadId) {
      const existing = threadSchema.parse(await connection.call("thread/read", { threadId: options.threadId, includeTurns: false }));
      if (!existing.thread.cwd || await realpath(existing.thread.cwd) !== cwd) {
        throw new Error("Cannot resume a Codex thread from another project");
      }
    }
    const params = {
      cwd, ...(options.model ? { model: options.model } : {}),
      approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write",
    };
    const started = threadSchema.parse(await connection.call(options.threadId ? "thread/resume" : "thread/start", {
      ...params, ...(options.threadId ? { threadId: options.threadId } : {}),
    }));
    threadId = started.thread.id;
    signal.throwIfAborted();
    publish();
    const turn = turnSchema.parse(await connection.call("turn/start", {
      threadId, input: [{ type: "text", text: options.prompt, text_elements: [] }],
    }));
    turnId = turn.turn.id;
    return await done;
  } catch (error) {
    if (speechState === "running") { speechState = signal.aborted ? "interrupted" : "failed"; publish(); }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}${threadId ? ` (threadId=${threadId}, turnId=${turnId || "unknown"})` : ""}`);
  } finally {
    if (options.threadId) activeThreads.delete(options.threadId);
    signal.removeEventListener("abort", abort);
    await connection.close();
  }
}
