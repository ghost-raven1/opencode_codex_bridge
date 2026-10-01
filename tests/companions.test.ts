import { describe, it, expect } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { CompanionDirector, spokenText, type CompanionEvent } from "../packages/companions/src/director.js";
import { appearanceFor } from "../packages/companions/src/presets.js";

function setup(speech: "all" | "coordinator-only" | "off" = "coordinator-only", extra: Record<string, unknown> = {}) {
  const events: CompanionEvent[] = [];
  const director = new CompanionDirector(configSchema.parse({ speech, ...extra }), e => events.push(e));
  const send = (type: string, properties: unknown) => director.event({ type, properties });
  const message = (role: string, id: string, mode = "build") => send("message.updated", { info: { id, sessionID: "s", role, mode } });
  const text = (id: string, messageID: string, text: string, extra: Record<string, unknown> = {}) =>
    send("message.part.updated", { part: { id, messageID, sessionID: "s", type: "text", text, ...extra } });
  return { events, send, message, text, director };
}
describe("companion event mapping", () => {
  it("announces a new user task once and cancels the previous speech", () => {
    const t = setup(); t.director.assignTask("s", { task: "Задача", messageID: "u" });
    t.message("user", "u"); t.message("user", "u");
    expect(t.events.filter(e => e.type === "stop")).toHaveLength(1);
    expect(t.events.filter(e => e.type === "speak").map(e => e.text)).toEqual(["Задача в работе."]);
  });
  it("speaks final assistant text once despite both idle notifications", () => {
    const t = setup(); t.message("assistant", "a"); t.text("p", "a", "При"); t.text("p", "a", "Привет");
    t.text("user-part", "u", "DO NOT READ USER INPUT");
    t.send("session.status", { sessionID: "s", status: { type: "idle" } }); t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "speak").map(e => e.text)).toEqual(["Привет"]);
  });
  it("speaks completed progress before a tool and final text exactly once", () => {
    const t = setup("coordinator-only", { workingPhrase: "" }); t.message("user", "u"); t.message("assistant", "progress");
    t.text("p", "progress", "Рабочее дерево", { time: { start: 1 } });
    t.text("p", "progress", "Рабочее дерево чистое. Проверю последний коммит с авторизацией.", { time: { start: 1, end: 2 } });
    expect(t.events.at(-1)).toMatchObject({ type: "speak", text: "Рабочее дерево чистое. Проверю последний коммит с авторизацией." });
    t.send("message.part.updated", { part: { id: "tool", messageID: "progress", sessionID: "s", type: "tool", tool: "bash",
      state: { status: "running", input: { command: "git status" } } } });
    t.send("message.updated", { info: { id: "progress", sessionID: "s", role: "assistant", time: { completed: 3 } } });
    t.message("assistant", "final"); t.text("f", "final", "Замечаний нет.", { time: { start: 4, end: 5 } });
    t.send("message.updated", { info: { id: "final", sessionID: "s", role: "assistant", time: { completed: 6 } } });
    t.text("f", "final", "Замечаний нет.", { time: { start: 4, end: 5 } });
    t.send("session.idle", { sessionID: "s" }); t.send("session.status", { sessionID: "s", status: { type: "idle" } });
    expect(t.events.filter(e => e.type === "speak").map(e => e.text)).toEqual([
      "Рабочее дерево чистое. Проверю последний коммит с авторизацией.", "Замечаний нет.",
    ]);
  });
  it("does not voice streaming fragments and deduplicates individual parts of one message", () => {
    const t = setup(); t.message("assistant", "a");
    t.text("p", "a", "Про", { time: { start: 1 } }); t.text("p", "a", "Проверяю код", { time: { start: 1 } });
    t.send("session.status", { sessionID: "s", status: { type: "busy" } });
    expect(t.events.filter(e => e.type === "speak")).toHaveLength(0);
    t.text("p", "a", "Проверяю код", { time: { start: 1, end: 2 } });
    t.text("q", "a", "Проверяю тесты", { time: { start: 3, end: 4 } });
    t.send("message.updated", { info: { id: "a", sessionID: "s", role: "assistant", time: { completed: 5 } } });
    t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "speak").map(e => e.text)).toEqual(["Проверяю код", "Проверяю тесты"]);
  });
  it("uses message completion as a fallback when a text part has no end timestamp", () => {
    const t = setup(); t.message("assistant", "a"); t.text("p", "a", "Проверю файл");
    t.send("message.updated", { info: { id: "a", sessionID: "s", role: "assistant", time: { completed: 2 } } });
    expect(t.events.at(-1)).toMatchObject({ type: "speak", text: "Проверю файл" });
    t.text("p", "a", "Проверю файл", { time: { start: 1, end: 2 } }); t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "speak")).toHaveLength(1);
  });
  it("does not count an empty part as spoken before a late completed part arrives", () => {
    const t = setup(); t.message("assistant", "a"); t.text("p", "a", "");
    t.send("message.updated", { info: { id: "a", sessionID: "s", role: "assistant", time: { completed: 2 } } });
    t.text("p", "a", "Готовый ответ", { time: { start: 1, end: 2 } });
    expect(t.events.filter(e => e.type === "speak").map(e => e.text)).toEqual(["Готовый ответ"]);
  });
  it("keeps synthetic, ignored and reasoning content silent even with completion timestamps", () => {
    const t = setup(); t.message("assistant", "a");
    t.text("synthetic", "a", "Synthetic", { synthetic: true, time: { start: 1, end: 2 } });
    t.text("ignored", "a", "Ignored", { ignored: true, time: { start: 1, end: 2 } });
    t.send("message.part.updated", { part: { sessionID: "s", messageID: "a", id: "reasoning", type: "reasoning", text: "Private", time: { end: 2 } } });
    t.send("message.part.updated", { part: { sessionID: "s", messageID: "a", id: "tool", type: "tool", output: "Secret", time: { end: 2 } } });
    t.send("message.updated", { info: { sessionID: "s", id: "a", role: "assistant", time: { completed: 3 } } });
    t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "speak")).toHaveLength(0);
  });
  it.each(["coordinator-only", "all"] as const)("keeps %s policy for subagent progress", speech => {
    const t = setup(speech); t.send("session.created", { info: { id: "s", parentID: "root" } });
    t.message("assistant", "a", "explore"); t.text("p", "a", "Изучаю документацию", { time: { start: 1, end: 2 } });
    expect(t.events.filter(e => e.type === "speak")).toHaveLength(speech === "all" ? 1 : 0);
  });
  it("never replays cancelled text or stale assistant completion after a new user task", () => {
    const t = setup("all", { workingPhrase: "" }); t.message("user", "u"); t.message("assistant", "a");
    t.text("progress", "a", "Начинаю проверку", { time: { start: 1, end: 2 } });
    t.send("session.error", { sessionID: "s", error: { name: "MessageAbortedError" } });
    expect(t.events.filter(e => e.type === "stop").length).toBeGreaterThan(0);
    t.text("late", "a", "Старый ответ", { time: { end: 3 } });
    t.send("message.updated", { info: { sessionID: "s", id: "a", role: "assistant", parentID: "u", time: { completed: 4 } } });
    t.director.assignTask("s", { task: "Новая задача", messageID: "u2" });
    t.message("user", "u2"); t.message("assistant", "b");
    t.send("message.updated", { info: { sessionID: "s", id: "late-assistant", role: "assistant", parentID: "u", time: { completed: 5 } } });
    t.text("late-parent", "late-assistant", "Ответ прошлой задачи", { time: { end: 5 } });
    t.text("new", "b", "Новая задача готова", { time: { end: 6 } });
    t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "speak").map(e => e.text)).toEqual(["Начинаю проверку", "Новая задача готова"]);
  });
  it("never voices reasoning or tool output", () => {
    const t = setup(); t.message("assistant", "a");
    t.send("message.part.updated", { part: { sessionID: "s", type: "reasoning", text: "private" } });
    t.send("message.part.updated", { part: { sessionID: "s", type: "tool", output: "secret" } });
    t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "speak")).toHaveLength(0);
  });
  it("keeps error state when idle follows failure", () => {
    const t = setup(); t.send("session.error", { sessionID: "s" }); t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "state").at(-1)?.state).toBe("error");
  });
  it("keeps approvals visible through idle and tool events until all requests are answered", () => {
    const t = setup(); t.message("assistant", "a"); t.text("p", "a", "Пока рано озвучивать");
    t.send("permission.asked", { sessionID: "s", id: "permission" });
    t.send("question.asked", { sessionID: "s", id: "question" });
    t.send("session.idle", { sessionID: "s" });
    t.send("message.part.updated", { part: { sessionID: "s", type: "tool" } });
    t.send("permission.replied", { sessionID: "s", requestID: "permission", reply: "once" });
    expect(t.events.filter(e => e.type === "state").at(-1)?.state).toBe("waiting");
    expect(t.events.filter(e => e.type === "speak")).toHaveLength(0);
    t.send("question.replied", { sessionID: "s", requestID: "question", answers: [] });
    expect(t.events.at(-1)?.state).toBe("thinking");
  });
  it("clears legacy permission IDs on reply", () => {
    const t = setup(); t.send("permission.updated", { sessionID: "s", id: "p" });
    t.send("permission.replied", { sessionID: "s", permissionID: "p", response: "once" });
    expect(t.events.at(-1)?.state).toBe("thinking");
  });
  it("cancels aborted speech without claiming success or announcing an error", () => {
    const t = setup(); t.message("assistant", "a"); t.text("p", "a", "Незавершенный ответ");
    t.send("session.error", { sessionID: "s", error: { name: "MessageAbortedError" } });
    t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "state").at(-1)?.state).toBe("idle");
    expect(t.events.filter(e => e.type === "speak")).toHaveLength(0);
    expect(t.events.some(e => e.type === "stop")).toBe(true);
    t.director.assignTask("s", { task: "Новая задача", messageID: "next" });
    t.message("user", "next"); t.message("assistant", "b"); t.text("q", "b", "Новый ответ");
    t.send("session.idle", { sessionID: "s" });
    expect(t.events.at(-1)?.text).toBe("Новый ответ");
  });
  it("does not interrupt its own error announcement when the error is delivered twice", () => {
    const t = setup();
    t.send("message.updated", { info: { sessionID: "s", id: "a", role: "assistant", error: { name: "APIError" } } });
    const count = t.events.length;
    t.send("session.error", { sessionID: "s", error: { name: "APIError" } });
    expect(t.events).toHaveLength(count);
    expect(t.events.at(-1)?.type).toBe("speak");
  });
  it("discards removed and subsequently ignored text before speaking", () => {
    const t = setup(); t.message("assistant", "a");
    t.text("deleted", "a", "Deleted"); t.text("ignored", "a", "Ignored"); t.text("keep", "a", "Готово");
    t.send("message.part.removed", { sessionID: "s", messageID: "a", partID: "deleted" });
    t.send("message.part.updated", { part: { sessionID: "s", messageID: "a", id: "ignored", type: "text", text: "Ignored", ignored: true } });
    t.send("session.idle", { sessionID: "s" });
    expect(t.events.at(-1)?.text).toBe("Готово");
    t.send("message.removed", { sessionID: "s", messageID: "a" });
    expect(t.events.at(-1)?.type).toBe("stop");
  });
  it("respects primary-only speech and uses real subagent roles", () => {
    const t = setup(); t.send("session.created", { info: { id: "s", parentID: "root" } });
    t.message("assistant", "a", "explore"); t.text("p", "a", "Found it"); t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "speak")).toHaveLength(0);
    expect(t.events.at(-1)?.appearance?.column).toBe(2);
  });
  it("can mute all speech", () => {
    const t = setup("off"); t.message("user", "u"); t.send("session.error", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "speak")).toHaveLength(0);
  });
  it("infers role from user text parts and never from an assistant answer", () => {
    const t = setup(); t.message("user", "u"); t.text("task", "u", "Проверь изменения на регрессии");
    expect(t.events.filter(e => e.type === "state").at(-1)?.role).toBe("reviewer");
    t.message("assistant", "a", "general"); t.text("answer", "a", "Реализуй новую функцию и исследуй документацию");
    t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "state").at(-1)?.role).toBe("reviewer");
    expect(t.events.at(-1)?.type).toBe("speak");
  });
  it("assigns a full task before user events without losing role or primary speech", () => {
    const t = setup();
    t.director.assignTask("s", { agent: "build", task: "Implement login", messageID: "u" });
    t.message("user", "u");
    expect(t.events.filter(e => e.type === "state").at(-1)?.role).toBe("developer");
    expect(t.events.at(-1)).toMatchObject({ type: "speak", role: "developer", text: "Задача в работе." });
    t.director.assignTask("s", { agent: "build", task: "Продолжай", messageID: "next" }); t.message("user", "next");
    expect(t.events.filter(e => e.type === "state").at(-1)?.role).toBe("coordinator");
  });
  it("infers a general subagent role from running task input before its first message", () => {
    const t = setup(); t.message("assistant", "a");
    t.send("message.part.updated", { part: { id: "task", messageID: "a", sessionID: "s", type: "tool", tool: "task",
      state: { status: "running", input: { description: "Research SDK docs", prompt: "Find the official API reference", subagent_type: "general" },
        metadata: { sessionId: "child" } } } });
    expect(t.events.find(e => e.characterId === "child" && e.type === "state")?.role).toBe("researcher");
    t.send("message.updated", { info: { id: "child-user", sessionID: "child", role: "user", agent: "general" } });
    expect(t.events.filter(e => e.characterId === "child" && e.type === "state").at(-1)?.role).toBe("researcher");
    expect(t.events.filter(e => e.characterId === "child" && e.type === "speak")).toHaveLength(0);
  });
  it("does not announce a subagent planner as the primary coordinator", () => {
    const t = setup();
    t.director.assignTask("s", { agent: "general", task: "Составь план миграции", parentID: "root" });
    t.message("user", "u", "general");
    expect(t.events.filter(e => e.type === "state").at(-1)?.role).toBe("coordinator");
    expect(t.events.filter(e => e.type === "speak")).toHaveLength(0);
  });
  it("preserves configured agent roles over task inference", () => {
    const t = setup("all", { agentRoles: { general: "reviewer" } });
    t.director.assignTask("s", { agent: "general", task: "Implement parser", parentID: "root" });
    t.message("user", "u", "general"); t.text("task", "u", "Research the protocol");
    expect(t.events.filter(e => e.type === "state").at(-1)?.role).toBe("reviewer");
  });
  it("removes the character when its session is deleted", () => {
    const t = setup(); t.send("session.created", { info: { id: "s" } }); t.message("assistant", "a");
    t.send("session.deleted", { info: { id: "s" } });
    expect(t.events.at(-1)).toEqual({ type: "remove", characterId: "s" });
  });
  it("does not allocate characters for unrelated global or late session events", () => {
    const t = setup();
    t.send("project.updated", { info: { id: "project" } });
    t.send("message.updated", { info: { id: "message", role: "assistant" } });
    t.send("session.idle", { sessionID: "unknown" });
    t.text("late", "missing", "Late");
    expect(t.events).toEqual([]);
  });
  it("does not resurrect deleted or evicted sessions on delayed parts and errors", () => {
    const t = setup(); t.send("session.created", { info: { id: "s" } }); t.message("assistant", "a");
    for (let n = 0; n < 128; n++) t.send("session.created", { info: { id: `session-${n}` } });
    expect(t.events).toContainEqual({ type: "remove", characterId: "s" });
    const count = t.events.length;
    t.text("late", "a", "Late"); t.send("session.error", { sessionID: "s" });
    expect(t.events).toHaveLength(count);
    t.director.assignTask("s", { task: "Продолжай", messageID: "resume" }); t.message("user", "resume");
    expect(t.events.at(-1)?.text).toBe("Задача в работе.");
    t.send("session.deleted", { info: { id: "s" } });
    const afterDelete = t.events.length;
    t.message("assistant", "late-assistant");
    expect(t.events).toHaveLength(afterDelete);
  });
  it("restores child session role on resume and removes archived sessions", () => {
    const t = setup("all"); t.send("session.updated", { info: { id: "s", parentID: "parent" } });
    expect(t.events).toEqual([]); t.message("assistant", "a", "general");
    expect(t.events.at(-1)?.role).toBe("developer");
    t.send("session.updated", { info: { id: "s", time: { archived: 123 } } });
    expect(t.events.at(-1)).toEqual({ type: "remove", characterId: "s" });
  });
  it("bounds streamed parts and removes text from previous assistant messages", () => {
    const t = setup("all", { maxSpeechLength: 8000 }); t.message("assistant", "a");
    for (let n = 0; n < 130; n++) t.text(`part-${n}`, "a", `text${n}`);
    t.send("session.idle", { sessionID: "s" });
    const text = t.events.at(-1)?.text ?? "";
    expect(text.startsWith("text2 ")).toBe(true);
    t.message("assistant", "b"); t.text("b-part", "b", "Только новый ответ");
    t.send("session.idle", { sessionID: "s" });
    expect(t.events.at(-1)?.text).toBe("Только новый ответ");
  });
  it("uses deterministic appearances and different presets by role", () => {
    expect(appearanceFor("agent-a", "developer")).toEqual(appearanceFor("agent-a", "developer"));
    expect(appearanceFor("agent-a", "developer").column).not.toBe(appearanceFor("agent-a", "reviewer").column);
  });
  it("combines role-specific head and outfit choices without changing the role badge", () => {
    const config = configSchema.parse({ appearance: { roles: { developer: { head: "researcher", outfit: "reviewer" } } } });
    const appearance = appearanceFor("a", "developer", config.appearance);
    expect(appearance).toMatchObject({ column: 1, label: "CODE", headColumn: 2, bodyColumn: 3 });
    const t = setup("all", { appearance: config.appearance }); t.message("assistant", "a", "general");
    expect(t.events.at(-1)?.appearance).toMatchObject({ headColumn: 2, bodyColumn: 3 });
  });
  it("seeds head and outfit independently and allows explicit overrides", () => {
    const seeded = configSchema.parse({ appearance: { mode: "seeded" } }).appearance;
    const a = appearanceFor("agent-a", "developer", seeded);
    expect(a).toEqual(appearanceFor("agent-a", "developer", seeded));
    const combinations = new Set(Array.from({ length: 32 }, (_, n) => {
      const appearance = appearanceFor(`agent-${n}`, "developer", seeded);
      return `${appearance.headColumn}:${appearance.bodyColumn}`;
    }));
    expect(combinations.size).toBeGreaterThan(8);
    const override = configSchema.parse({ appearance: { mode: "seeded", roles: { developer: { head: "reviewer" } } } }).appearance;
    expect(appearanceFor("agent-a", "developer", override)).toMatchObject({ headColumn: 3, bodyColumn: a.bodyColumn });
    expect(() => configSchema.parse({ appearance: { roles: { developer: { head: "unknown" } } } })).toThrow();
  });
  it("strips code blocks and URLs, and caps speech", () => {
    expect(spokenText("Готово. ```secret code``` https://example.com [Ссылка](https://example.com)", 100)).toBe("Готово. Ссылка");
    expect(spokenText("x".repeat(200), 100)).toHaveLength(100);
  });
});
