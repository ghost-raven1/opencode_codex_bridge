import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { CompanionDirector, type CompanionEvent } from "../packages/companions/src/director.js";
import { CompanionLifecycle } from "../packages/companions/src/lifecycle.js";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); });
function setup(startTask = true) {
  vi.useFakeTimers();
  const output: CompanionEvent[] = [], config = configSchema.parse({ speech: "off" });
  const lifecycle = new CompanionLifecycle(config, event => output.push(event));
  const director = new CompanionDirector(config, event => lifecycle.event(event));
  cleanups.push(() => lifecycle.dispose());
  const send = (type: string, properties: unknown) => director.event({ type, properties });
  const assistant = (id: string, completed = false, finish = "stop") => send("message.updated", {
    info: { sessionID: "s", id, role: "assistant", parentID: "u", time: { created: 1, ...(completed ? { completed: 2 } : {}) }, finish },
  });
  const tool = (id: string, status: string) => send("message.part.updated", {
    part: { sessionID: "s", id, messageID: "a", type: "tool", tool: "bash", state: { status } },
  });
  const idle = () => {
    send("session.status", { sessionID: "s", status: { type: "idle" } });
    send("session.idle", { sessionID: "s" });
  };
  if (startTask) {
    director.assignTask("s", { messageID: "u", task: "Проверь код" });
    send("message.updated", { info: { sessionID: "s", id: "u", role: "user" } });
  }
  const stays = () => { vi.advanceTimersByTime(30_000); expect(output.some(event => event.type === "remove")).toBe(false); };
  return { output, lifecycle, send, assistant, tool, idle, stays };
}

describe("active task cannot be retired by an idle notification", () => {
  it("keeps a busy session whose initial user event was missed", () => {
    const t = setup(false); t.send("session.status", { sessionID: "s", status: { type: "busy" } });
    t.idle(); t.stays();
  });
  it("keeps the character while the first assistant response is still pending", () => {
    const t = setup(); t.idle(); t.stays();
    t.assistant("a"); t.stays();
  });
  it("holds an unfinished assistant stream, then starts thirty seconds only after completion and speech drain", () => {
    const t = setup(); t.assistant("a"); t.idle(); t.stays();
    t.lifecycle.speechActivity(new Set(["s"])); t.assistant("a", true); t.stays();
    t.lifecycle.speechActivity(new Set()); vi.advanceTimersByTime(29_999);
    expect(t.output.some(event => event.type === "remove")).toBe(false);
    vi.advanceTimersByTime(1); expect(t.output.at(-1)).toMatchObject({ type: "remove", characterId: "s" });
  });
  it.each(["tool-calls", "unknown"])("keeps pending/running tools and a %s model step visible", finish => {
    const t = setup(); t.assistant("a"); t.tool("one", "running"); t.tool("two", "pending");
    t.assistant("a", true, finish); t.idle(); t.stays();
    t.tool("one", "completed"); t.stays(); t.tool("two", "completed"); t.stays();
    t.assistant("b"); t.stays(); t.assistant("b", true); t.idle();
    vi.advanceTimersByTime(30_000); expect(t.output.at(-1)?.type).toBe("remove");
  });
  it("does not reuse an earlier idle after generation has resumed", () => {
    const t = setup(); t.assistant("a"); t.idle();
    t.send("session.status", { sessionID: "s", status: { type: "busy" } });
    t.assistant("a", true); t.stays(); t.idle();
    vi.advanceTimersByTime(30_000); expect(t.output.at(-1)?.type).toBe("remove");
  });
  it("accepts a late final tool result after a confirmed final answer and idle", () => {
    const t = setup(); t.assistant("a"); t.tool("one", "running");
    t.assistant("a", true); t.idle(); t.stays();
    t.tool("one", "completed"); vi.advanceTimersByTime(30_000);
    expect(t.output.at(-1)?.type).toBe("remove");
  });
});
