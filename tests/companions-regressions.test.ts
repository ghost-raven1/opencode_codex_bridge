import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { CompanionDirector, type CompanionEvent } from "../packages/companions/src/director.js";
import { CompanionLifecycle } from "../packages/companions/src/lifecycle.js";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); });

function setup() {
  vi.useFakeTimers();
  const events: CompanionEvent[] = [], config = configSchema.parse({ speech: "all", workingPhrase: "" });
  const lifecycle = new CompanionLifecycle(config, event => events.push(event));
  const director = new CompanionDirector(config, event => lifecycle.event(event));
  cleanups.push(() => lifecycle.dispose());
  const send = (type: string, properties: unknown) => director.event({ type, properties });
  const info = (sessionID: string, id: string, role: string, extra = {}) =>
    send("message.updated", { info: { sessionID, id, role, ...extra } });
  const text = (sessionID: string, messageID: string, value: string, complete = true) =>
    send("message.part.updated", { part: { sessionID, messageID, id: `${messageID}-text`, type: "text", text: value,
      time: complete ? { end: 1 } : {} } });
  const user = (sessionID: string, id: string) => {
    info(sessionID, id, "user"); text(sessionID, id, "Поищи баги");
  };
  return { events, send, info, text, user, lifecycle };
}

describe("companion audit regressions", () => {
  it.each([false, true])("keeps child identity and final speech after task metadata refresh (own user: %s)", ownUser => {
    const t = setup(); t.user("parent", "parent-user"); t.info("parent", "parent-answer", "assistant");
    const metadata = (status: string) => t.send("message.part.updated", { part: {
      sessionID: "parent", messageID: "parent-answer", id: "task", type: "tool", tool: "task",
      state: { status, input: { description: "Поищи баги", prompt: "Проверь код", subagent_type: "general" },
        metadata: { sessionId: "child" } },
    } });
    metadata("running");
    if (ownUser) t.user("child", "child-user");
    t.info("child", "child-answer", "assistant");
    metadata("running"); metadata("completed");
    t.lifecycle.speechActivity(new Set(["child"]));
    t.text("child", "child-answer", "Проверка завершена.");
    t.info("child", "child-answer", "assistant", { time: { completed: 2 }, finish: "stop" });
    t.send("session.idle", { sessionID: "child" });
    const expectedTask = ownUser ? "child-user" : "parent-user";
    expect(t.events.filter(event => event.characterId === "child" && event.type === "speak"))
      .toEqual([expect.objectContaining({ taskId: expectedTask, text: "Проверка завершена." })]);
    expect(t.events.filter(event => event.characterId === "child" && event.type === "state").at(-1))
      .toMatchObject({ taskId: expectedTask, state: "success", role: "reviewer" });
    vi.advanceTimersByTime(20_000);
    expect(t.events.some(event => event.characterId === "child" && event.type === "remove")).toBe(false);
    t.lifecycle.speechActivity(new Set()); vi.advanceTimersByTime(10_000);
    expect(t.events.at(-1)).toMatchObject({ characterId: "child", type: "remove", taskId: expectedTask });
  });

  it("removes a long fenced block before the speech cap and retains the closing explanation", () => {
    const t = setup(); t.user("s", "u"); t.info("s", "a", "assistant");
    const prefix = "Вступление.\n```ts\n", code = "const INTERNAL = 'do not speak';\n".repeat(200);
    t.text("s", "a", prefix + code, false);
    expect(t.events.filter(event => event.type === "speak")).toEqual([]);
    t.text("s", "a", prefix + code + "```\nЗаключение.");
    expect(t.events.filter(event => event.type === "speak").map(event => event.text)).toEqual(["Вступление. Заключение."]);
  });

  it("never reads an unclosed code fence from a completed response", () => {
    const t = setup(); t.user("s", "u"); t.info("s", "a", "assistant");
    t.text("s", "a", "Пояснение.\n```ts\nconst INTERNAL = 'do not speak';");
    expect(t.events.filter(event => event.type === "speak").map(event => event.text)).toEqual(["Пояснение."]);
  });

  it.each(["~~~", "````"])("does not read code inside a %s fence", fence => {
    const t = setup(); t.user("s", "u"); t.info("s", "a", "assistant");
    const code = fence === "````" ? "```ts\nconst INTERNAL = 1;\n```" : "const INTERNAL = 1;";
    t.text("s", "a", `Пояснение.\n${fence}\n${code}\n${fence}\nИтог.`);
    expect(t.events.filter(event => event.type === "speak").map(event => event.text)).toEqual(["Пояснение. Итог."]);
  });

  it.each(["```", "~~~"])("does not close a multiline %s block on a code literal", fence => {
    const t = setup(); t.user("s", "u"); t.info("s", "a", "assistant");
    t.text("s", "a", `Пояснение.\n${fence}ts\nconst marker = '${fence}';\nsecretCall();\n${fence}\nИтог.`);
    expect(t.events.filter(event => event.type === "speak").map(event => event.text)).toEqual(["Пояснение. Итог."]);
  });
});
