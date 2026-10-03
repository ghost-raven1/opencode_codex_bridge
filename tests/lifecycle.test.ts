import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../packages/companions/src/config.js";
import { CompanionLifecycle } from "../packages/companions/src/lifecycle.js";
import type { CompanionEvent } from "../packages/companions/src/director.js";
import { appearanceFor } from "../packages/companions/src/presets.js";
function setup() {
  vi.useFakeTimers();
  const send = vi.fn(), life = new CompanionLifecycle(configSchema.parse({}), send);
  const state = (id: string, state = "working", taskId = "task", role = "developer") => life.event({ type: "state", characterId: id, state, taskId, role } as CompanionEvent);
  return { send, life, state };
}
afterEach(() => vi.useRealTimers());
describe("companion residency", () => {
  it("starts empty; waits for task and all queued speech, then retires after thirty seconds", () => {
    const t = setup(); expect(t.send).not.toHaveBeenCalled();
    t.state("a"); t.life.speechActivity(new Set(["a"]), "a"); t.state("a", "success");
    vi.advanceTimersByTime(30_000);
    expect(t.send.mock.calls.some(([e]) => e.type === "remove")).toBe(false);
    t.life.speechActivity(new Set()); vi.advanceTimersByTime(29_999);
    expect(t.send.mock.calls.some(([e]) => e.type === "remove")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "remove", characterId: "a" }));
    const count = t.send.mock.calls.length;
    t.state("a", "success"); t.life.event({ type: "speak", characterId: "a", taskId: "task", text: "Поздняя реплика" });
    expect(t.send).toHaveBeenCalledTimes(count);
    t.state("a", "working", "new-task"); expect(t.send.mock.calls.length).toBeGreaterThan(count);
    t.life.dispose();
  });
  it("permission wait persists and new work cancels a scheduled departure", () => {
    const t = setup(); t.state("a", "waiting"); vi.advanceTimersByTime(60_000);
    t.state("a", "success"); vi.advanceTimersByTime(29_000); t.state("a", "working", "next"); vi.advanceTimersByTime(30_000);
    expect(t.send.mock.calls.some(([e]) => e.type === "remove")).toBe(false); t.life.dispose();
  });
  it("allocates four distinct voices even for four developers and protects the speaker on overflow", () => {
    const t = setup(); ["a", "b", "c", "d"].forEach(id => t.state(id));
    expect(new Set(["a", "b", "c", "d"].map(id => t.life.voiceFor(id, "developer"))).size).toBe(4);
    t.life.speechActivity(new Set(["a"]), "a"); t.state("e");
    expect(t.send).toHaveBeenCalledWith(expect.objectContaining({ type: "remove", characterId: "b", visualOnly: true }));
    expect(t.send.mock.calls.some(([e]) => e.type === "remove" && e.characterId === "a")).toBe(false);
    expect(new Set(["a", "c", "d", "e"].map(id => t.life.voiceFor(id, "developer"))).size).toBe(4);
    t.life.dispose();
  });
  it("keeps the assigned voice if the new role's preferred voice is occupied", () => {
    const t = setup(); t.state("a", "working", "task", "developer"); t.state("b", "working", "task", "reviewer");
    const voice = t.life.voiceFor("a", "developer");
    t.state("a", "working", "task", "reviewer"); expect(t.life.voiceFor("a", "reviewer")).toBe(voice);
    t.life.dispose();
  });
  it("uses distinct synthetic references for specialists alongside the original team", () => {
    const t = setup(); t.state("original");
    for (const agent of ["designer", "devops", "tester"]) {
      t.life.event({ type: "state", characterId: agent, state: "working", role: "developer",
        appearance: appearanceFor(agent, "developer", undefined, agent) });
      expect(t.life.voiceFor(agent, "developer")).toBe(`${agent}-local`);
    }
    expect(t.life.voiceFor("original", "developer")).toBe("Vivian");
    t.life.dispose();
  });
});
