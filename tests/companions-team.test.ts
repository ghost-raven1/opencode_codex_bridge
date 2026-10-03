import { describe, expect, it } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { CompanionDirector, type CompanionEvent } from "../packages/companions/src/director.js";
import { CompanionLifecycle } from "../packages/companions/src/lifecycle.js";

describe("native team identity contract", () => {
  it.each(["task", "session"])("retains parent and invocation when %s metadata arrives after the child has started", source => {
    const events: CompanionEvent[] = [], config = configSchema.parse({ speech: "off" });
    const lifecycle = new CompanionLifecycle(config, event => events.push(event));
    const director = new CompanionDirector(config, event => lifecycle.event(event));
    try {
      director.assignTask("child", { messageID: "own-user", task: "Проверь код", agent: "review" });
      director.event({ type: "message.updated", properties: { info: { sessionID: "child", id: "own-user", role: "user" } } });
      const before = events.at(-1)!;
      if (source === "task") director.assignTask("child", { task: "Проверь код", agent: "review", parentID: "parent" });
      else director.event({ type: "session.updated", properties: { info: { id: "child", parentID: "parent" } } });
      expect(events.at(-1)).toMatchObject({ type: "state", characterId: "child", taskId: "own-user",
        parentCharacterId: "parent", invocationId: before.invocationId, name: before.name });
      director.assignTask("child", { task: "Проверь код", agent: "review", parentID: "parent" });
      lifecycle.replay();
      expect(events.at(-1)).toMatchObject({ parentCharacterId: "parent", invocationId: before.invocationId });
    } finally { lifecycle.dispose(); }
  });

  it("forwards the real parent without inventing teammates for the root", () => {
    const events: CompanionEvent[] = [], director = new CompanionDirector(configSchema.parse({ speech: "off" }), event => events.push(event));
    director.assignTask("root", { messageID: "u", task: "Напиши код" });
    director.event({ type: "message.updated", properties: { info: { sessionID: "root", id: "u", role: "user" } } });
    expect(events.at(-1)).toMatchObject({ type: "state", characterId: "root" });
    expect(events.at(-1)?.parentCharacterId).toBeUndefined();
    director.assignTask("child", { parentID: "root", task: "Напиши код", agent: "build" });
    expect(events.at(-1)).toMatchObject({ characterId: "child", parentCharacterId: "root" });
  });
});
