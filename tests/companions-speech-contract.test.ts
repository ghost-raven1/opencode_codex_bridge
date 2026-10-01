import { describe, expect, it } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { CompanionDirector, type CompanionEvent } from "../packages/companions/src/director.js";

function setup(speech = "all", workingPhrase = "") {
  const events: CompanionEvent[] = [];
  const director = new CompanionDirector(configSchema.parse({ speech, workingPhrase }), event => events.push(event));
  const send = (type: string, properties: unknown) => director.event({ type, properties });
  const info = (id: string, role: string, extra: Record<string, unknown> = {}) =>
    send("message.updated", { info: { sessionID: "s", id, role, agent: "build", ...extra } });
  const text = (id: string, messageID: string, value: string, extra: Record<string, unknown> = {}) =>
    send("message.part.updated", { part: { sessionID: "s", id, messageID, type: "text", text: value, time: { end: 1 }, ...extra } });
  const user = (id: string, task = "Поищи баги") => {
    director.assignTask("s", { agent: "build", task, messageID: id }); info(id, "user");
  };
  const tool = (snapshot: unknown, extra: Record<string, unknown> = {}) => send("message.part.updated", { part: {
    sessionID: "s", id: "tool", messageID: "a", type: "tool", tool: "codex",
    state: { status: "running", input: { prompt: "Implement a parser" }, metadata: { output: "PRIVATE PREVIEW", codexSpeech: snapshot } }, ...extra,
  } });
  return { director, events, send, info, text, user, tool };
}
const publicMessage = (messageId: string, text: string) => ({ messageId, text, state: "completed" });
const snapshot = (messages: ReturnType<typeof publicMessage>[] = [], state = "running") =>
  ({ runId: "run", threadId: "thread", messages, state });

describe("task identity and compaction", () => {
  it("does not publish idle characters from session metadata or early user hooks", () => {
    const t = setup();
    t.send("session.created", { info: { id: "s" } });
    t.send("session.updated", { info: { id: "s", parentID: "parent" } });
    t.send("session.idle", { sessionID: "s" });
    t.director.assignTask("s", { task: "Review code", messageID: "u" });
    expect(t.events).toEqual([]);
    t.info("u", "user");
    expect(t.events.at(-1)).toMatchObject({ type: "state", taskId: "u", role: "reviewer", state: "thinking" });
  });
  it("keeps the active task until the next hook's user message actually arrives", () => {
    const t = setup(); t.user("u"); t.info("a", "assistant", { parentID: "u" });
    t.director.assignTask("s", { task: "Implement the fix", messageID: "next", agent: "build" });
    t.text("last", "a", "Закончил проверку.");
    expect(t.events.at(-1)).toMatchObject({ type: "speak", taskId: "u", role: "reviewer" });
    t.info("next", "user");
    expect(t.events.at(-1)).toMatchObject({ type: "state", taskId: "next", role: "developer" });
  });
  it("keeps compaction summaries silent and preserves the original task through synthetic continuation", () => {
    const t = setup("all", "В работе"); t.user("u"); t.info("a", "assistant", { parentID: "u" });
    t.text("p", "a", "Проверяю изменения.");
    t.info("summary", "assistant", { parentID: "u", mode: "compaction", summary: true });
    t.text("summary-part", "summary", "Private compressed conversation");
    t.info("auto", "user");
    t.text("auto-part", "auto", "Continue if you have next steps", { synthetic: true });
    t.info("next-answer", "assistant", { parentID: "auto", agent: "general" });
    t.text("final", "next-answer", "Проверка завершена.");
    t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(event => event.type === "speak").map(event => event.text))
      .toEqual(["В работе", "Проверяю изменения.", "Проверка завершена."]);
    expect(t.events.filter(event => event.type === "speak").every(event => event.taskId === "u" && event.role === "reviewer")).toBe(true);
  });
  it("does not let ignored or synthetic user parts erase the task text", () => {
    const t = setup(); t.user("u");
    t.text("task", "u", "Поищи баги");
    t.text("helper", "u", "Implement everything", { synthetic: true });
    t.text("ignored", "u", "Research docs", { ignored: true });
    t.info("a", "assistant", { parentID: "u" }); t.text("answer", "a", "Результат");
    expect(t.events.at(-1)).toMatchObject({ type: "speak", taskId: "u", role: "reviewer" });
  });
  it("detects real user input without a hook once its public text part arrives", () => {
    const t = setup(); t.info("u", "user"); expect(t.events).toEqual([]);
    t.text("task", "u", "Поищи баги");
    expect(t.events.filter(event => event.type === "state").at(-1)).toMatchObject({ taskId: "u", role: "reviewer", state: "thinking" });
  });
  it("does not change the wire parent on a delayed update to an older user message", () => {
    const t = setup(); t.user("u"); t.info("a", "assistant", { parentID: "u" });
    t.user("next", "Implement a parser"); t.info("u", "user", { summary: { title: "Old task" } });
    t.info("next-answer", "assistant", { parentID: "next" }); t.text("answer", "next-answer", "Новый ответ");
    expect(t.events.at(-1)).toMatchObject({ type: "speak", taskId: "next", role: "developer", text: "Новый ответ" });
  });
  it("keeps an error terminal despite a delayed busy event", () => {
    const t = setup(); t.user("u");
    t.send("session.error", { sessionID: "s", error: { name: "APIError" } });
    t.send("session.status", { sessionID: "s", status: { type: "busy" } });
    expect(t.events.filter(event => event.type === "state").at(-1)?.state).toBe("error");
  });
});

describe("Codex public speech metadata", () => {
  it("creates a separate character and voices each completed public message once", () => {
    const t = setup(); t.user("u"); t.info("a", "assistant", { parentID: "u" });
    t.tool(snapshot());
    expect(t.events.find(event => event.characterId === "codex:s:run")).toMatchObject({
      type: "state", taskId: "u", runId: "run", role: "developer", state: "working",
      appearance: { label: "CODEX · CODE" },
    });
    const progress = publicMessage("progress", "Проверяю файл.");
    t.tool(snapshot([progress])); t.tool(snapshot([progress]));
    const done = snapshot([progress, publicMessage("final", "Готово.")], "completed");
    t.tool(done); t.tool(done); t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(event => event.type === "speak").map(event => [event.characterId, event.text]))
      .toEqual([["codex:s:run", "Проверяю файл."], ["codex:s:run", "Готово."]]);
    expect(t.events.filter(event => event.characterId === "codex:s:run" && event.type === "state").at(-1)?.state).toBe("success");
  });
  it("never parses preview, raw output, reasoning or incomplete metadata as speech", () => {
    const t = setup(); t.user("u"); t.info("a", "assistant");
    t.tool(undefined);
    t.tool(snapshot([{ messageId: "draft", text: "Draft", state: "streaming" } as never]));
    t.tool(snapshot([publicMessage("reasoning", "Private")]), { tool: "bash" });
    t.tool(undefined, { state: { status: "completed", output: JSON.stringify({ codexSpeech: snapshot([publicMessage("raw", "Raw")]) }) } });
    expect(t.events.filter(event => event.type === "speak")).toEqual([]);
    expect(t.events.filter(event => event.characterId.startsWith("codex:"))).toEqual([]);
  });
  it.each(["off", "coordinator-only"])("preserves %s policy for a Codex subtask", speech => {
    const t = setup(speech); t.user("u"); t.info("a", "assistant");
    t.tool(snapshot([publicMessage("m", "Готово")], "completed"));
    expect(t.events.filter(event => event.type === "speak")).toEqual([]);
  });
  it("holds completed Codex messages during permission prompts, then flushes them once", () => {
    const t = setup(); t.user("u"); t.info("a", "assistant"); t.tool(snapshot());
    t.send("permission.asked", { sessionID: "s", id: "approval" });
    t.tool(snapshot([publicMessage("m", "Продолжаю после разрешения.")]));
    expect(t.events.filter(event => event.type === "speak")).toEqual([]);
    expect(t.events.filter(event => event.characterId === "codex:s:run" && event.type === "state").at(-1)?.state).toBe("waiting");
    t.send("permission.replied", { sessionID: "s", requestID: "approval" });
    expect(t.events.filter(event => event.type === "speak").map(event => event.text)).toEqual(["Продолжаю после разрешения."]);
  });
  it("removes related runs on cancellation and rejects late old metadata after a new task", () => {
    const t = setup(); t.user("u"); t.info("a", "assistant"); t.tool(snapshot());
    t.send("session.error", { sessionID: "s", error: { name: "MessageAbortedError" } });
    expect(t.events).toContainEqual({ type: "remove", characterId: "codex:s:run", taskId: "u", runId: "run" });
    t.user("next", "Implement a feature"); t.info("b", "assistant", { parentID: "next" });
    t.tool(snapshot([publicMessage("old", "Stale answer")], "completed"));
    t.tool(snapshot([publicMessage("old", "Reused stale run")], "completed"), { messageID: "b" });
    expect(t.events.filter(event => event.type === "speak")).toEqual([]);
  });
  it("does not voice a new snapshot that reports interruption", () => {
    const t = setup(); t.user("u"); t.info("a", "assistant"); t.tool(snapshot());
    t.tool(snapshot([publicMessage("last", "Late text")], "interrupted"));
    t.tool(snapshot([publicMessage("last", "Late text")], "completed"));
    expect(t.events.filter(event => event.type === "speak")).toEqual([]);
  });
  it("does not reopen a completed run when an older running snapshot arrives late", () => {
    const t = setup(); t.user("u"); t.info("a", "assistant");
    t.tool(snapshot([publicMessage("final", "Готово")], "completed"));
    t.tool(snapshot([publicMessage("late", "Late running snapshot")]));
    expect(t.events.filter(event => event.type === "speak").map(event => event.text)).toEqual(["Готово"]);
    expect(t.events.filter(event => event.characterId === "codex:s:run" && event.type === "state").at(-1)?.state).toBe("success");
  });
  it("removes the run when the owning tool part is removed", () => {
    const t = setup(); t.user("u"); t.info("a", "assistant"); t.tool(snapshot());
    t.send("message.part.removed", { sessionID: "s", messageID: "a", partID: "tool" });
    expect(t.events.at(-1)).toMatchObject({ type: "remove", characterId: "codex:s:run", taskId: "u" });
  });
  it("does not retain dangling run references when a Codex character is evicted", () => {
    const t = setup(); t.user("u"); t.info("a", "assistant"); t.tool(snapshot());
    for (let n = 0; n < 128; n++) {
      t.send("session.created", { info: { id: `other-${n}` } });
      t.send("session.updated", { info: { id: "s" } });
    }
    expect(t.events.some(event => event.type === "remove" && event.characterId === "codex:s:run")).toBe(true);
    expect(() => t.send("permission.asked", { sessionID: "s", id: "p" })).not.toThrow();
    t.tool(snapshot([publicMessage("late", "Evicted answer")], "completed"));
    expect(t.events.filter(event => event.type === "speak")).toEqual([]);
  });
});
