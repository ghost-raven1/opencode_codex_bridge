import { describe, it, expect } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { CompanionDirector, spokenText, type CompanionEvent } from "../packages/companions/src/director.js";
import { appearanceFor } from "../packages/companions/src/presets.js";

function setup(speech: "all" | "coordinator-only" | "off" = "coordinator-only") {
  const events: CompanionEvent[] = [];
  const director = new CompanionDirector(configSchema.parse({ speech }), e => events.push(e));
  const send = (type: string, properties: unknown) => director.event({ type, properties });
  const message = (role: string, id: string, mode = "build") => send("message.updated", { info: { id, sessionID: "s", role, mode } });
  const text = (id: string, messageID: string, text: string) => send("message.part.updated", { part: { id, messageID, sessionID: "s", type: "text", text } });
  return { events, send, message, text };
}
describe("companion event mapping", () => {
  it("announces a new user task once and cancels the previous speech", () => {
    const t = setup(); t.message("user", "u"); t.message("user", "u");
    expect(t.events.filter(e => e.type === "stop")).toHaveLength(1);
    expect(t.events.filter(e => e.type === "speak").map(e => e.text)).toEqual(["Задача в работе."]);
  });
  it("speaks final assistant text once despite both idle notifications", () => {
    const t = setup(); t.message("assistant", "a"); t.text("p", "a", "При"); t.text("p", "a", "Привет");
    t.text("user-part", "u", "DO NOT READ USER INPUT");
    t.send("session.status", { sessionID: "s", status: { type: "idle" } }); t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "speak").map(e => e.text)).toEqual(["Привет"]);
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
  it("respects coordinator-only speech and uses real agent roles", () => {
    const t = setup(); t.message("assistant", "a", "explore"); t.text("p", "a", "Found it"); t.send("session.idle", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "speak")).toHaveLength(0);
    expect(t.events.at(-1)?.appearance?.column).toBe(2);
  });
  it("can mute all speech", () => {
    const t = setup("off"); t.message("user", "u"); t.send("session.error", { sessionID: "s" });
    expect(t.events.filter(e => e.type === "speak")).toHaveLength(0);
  });
  it("removes the character when its session is deleted", () => {
    const t = setup(); t.send("session.created", { info: { id: "s" } }); t.send("session.deleted", { info: { id: "s" } });
    expect(t.events.at(-1)).toEqual({ type: "remove", characterId: "s" });
  });
  it("uses deterministic appearances and different presets by role", () => {
    expect(appearanceFor("agent-a", "developer")).toEqual(appearanceFor("agent-a", "developer"));
    expect(appearanceFor("agent-a", "developer").column).not.toBe(appearanceFor("agent-a", "reviewer").column);
  });
  it("strips code blocks and URLs, and caps speech", () => {
    expect(spokenText("Готово. ```secret code``` https://example.com [Ссылка](https://example.com)", 100)).toBe("Готово. Ссылка");
    expect(spokenText("x".repeat(200), 100)).toHaveLength(100);
  });
});
