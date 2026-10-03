import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { CompanionDirector, type CompanionEvent } from "../packages/companions/src/director.js";
import { CompanionLifecycle } from "../packages/companions/src/lifecycle.js";
import { CharacterNames } from "../packages/companions/src/character-names.js";

function setup() {
  vi.useFakeTimers();
  const events: CompanionEvent[] = [];
  const config = configSchema.parse({ speech: "all" });
  const life = new CompanionLifecycle(config, event => events.push(event));
  const director = new CompanionDirector(config, event => life.event(event));
  const user = (sessionID: string, id: string, task = "Напиши функцию") => {
    director.assignTask(sessionID, { task, messageID: id });
    director.event({ type: "message.updated", properties: { info: { sessionID, id, role: "user" } } });
  };
  const latest = (id: string) => events.filter(event => event.characterId === id && event.type === "state").at(-1)!;
  return { events, life, director, user, latest };
}
afterEach(() => vi.useRealTimers());

describe("names belong to a companion invocation", () => {
  it("covers a full non-repeating local cycle without known offensive combinations", () => {
    const generator = new CharacterNames();
    const names = Array.from({ length: 400 }, () => generator.next([]));
    expect(new Set(names).size).toBe(400);
    expect(names.some(name => /сука|кака/iu.test(name))).toBe(false);
    expect(names.every(name => /^[А-ЯЁ][а-яё]{2,9}$/u.test(name))).toBe(true);
    expect(generator.next([])).toBe(names[0]);
  });
  it("assigns unique short names to all residents, preserving them through eviction and replay", () => {
    const t = setup();
    for (let i = 0; i < 7; i++) t.user(`agent-${i}`, `task-${i}`);
    const names = Array.from({ length: 7 }, (_, i) => t.latest(`agent-${i}`).name);
    expect(names.every(name => typeof name === "string" && /^[А-ЯЁ][а-яё]{2,9}$/u.test(name))).toBe(true);
    expect(new Set(names).size).toBe(7);
    t.life.speechActivity(new Set(["agent-0"]), "agent-0"); t.life.replay();
    expect(t.latest("agent-0").name).toBe(names[0]);
    t.life.dispose();
  });
  it("keeps the same name when child metadata precedes its own task, but gives a new real task a new name", () => {
    const t = setup(); t.user("parent", "parent-task");
    t.director.assignTask("child", { parentID: "parent", task: "Найди баг", agent: "tester" });
    const name = t.latest("child").name;
    expect(name).toEqual(expect.any(String));
    t.user("child", "child-task", "Найди баг");
    t.director.assignTask("child", { parentID: "parent", task: "Проверь результат", agent: "reviewer" });
    expect(t.latest("child").taskId).toBe("child-task");
    expect(t.latest("child").name).toBe(name);
    t.user("child", "next-task", "Реализуй исправление");
    expect(t.latest("child").name).not.toBe(name);
    t.life.dispose();
  });
  it("keeps its name through compaction, role changes, speech and a scheduled departure", () => {
    const t = setup(); t.user("agent", "original", "Напиши код");
    const original = t.latest("agent");
    expect(original.name).toEqual(expect.any(String));
    t.director.event({ type: "message.updated", properties: { info: { sessionID: "agent", id: "summary", role: "assistant", summary: true } } });
    t.director.event({ type: "message.updated", properties: { info: { sessionID: "agent", id: "continuation", role: "user" } } });
    t.director.event({ type: "message.part.updated", properties: { part: { id: "synthetic", sessionID: "agent", messageID: "continuation", type: "text", synthetic: true, text: "Continue" } } });
    t.director.event({ type: "message.updated", properties: { info: { sessionID: "agent", id: "answer", parentID: "continuation", role: "assistant" } } });
    expect(t.latest("agent").name).toBe(original.name);
    t.life.event({ ...t.latest("agent"), role: "reviewer", state: "success" });
    t.life.speechActivity(new Set(["agent"]), "agent"); vi.advanceTimersByTime(30_000);
    t.life.replay(); expect(t.latest("agent").name).toBe(original.name);
    expect(t.events.some(event => event.type === "remove" && !("visualOnly" in event))).toBe(false);
    t.life.dispose();
  });
  it("does not reuse the retiring name for the immediate next invocation", () => {
    const t = setup(); t.user("agent", "first"); const first = t.latest("agent");
    t.life.event({ ...first, state: "success" }); vi.advanceTimersByTime(30_000);
    t.user("agent", "second"); expect(t.latest("agent").name).not.toBe(first.name);
    t.life.dispose();
  });
});
