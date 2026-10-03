import { describe, expect, it } from "vitest";
import { toolActivity } from "../packages/companions/src/tool-activity.js";
import { CompanionDirector, type CompanionEvent } from "../packages/companions/src/director.js";
import { configSchema } from "../packages/companions/src/config.js";

describe("visible work reflects real tools", () => {
  it.each([
    ["read", {}, "read"], ["apply_patch", {}, "edit"], ["grep", {}, "search"],
    ["context7_query-docs", {}, "read"], ["playwright_browser_navigate", {}, "test"], ["task", {}, "delegate"],
    ["bash", { command: "npm run test:native" }, "test"],
    ["bash", { command: "node --test total.test.js" }, "test"],
    ["bash", { command: "cargo test" }, "test"],
    ["bash", { command: "go test ./..." }, "test"],
    ["bash", { command: "swift test --parallel" }, "test"],
    ["bash", { command: "cd /tmp && PATH=/bin npm run check" }, "test"],
    ["bash", { command: "pnpm build" }, "build"], ["bash", { command: "swiftc file.swift" }, "build"],
    ["bash", { command: "rg -n TODO src" }, "search"], ["bash", { command: "cat README.md" }, "read"],
    ["bash", { command: "echo 'npm test'" }, "run"], ["unknown", {}, "run"],
    ["bash", { command: "git commit -m 'fix; npm test && npm run build'" }, "run"],
  ])("%s %j", (tool, input, expected) => expect(toolActivity(tool as string, input)).toBe(expected));

  it("keeps another running tool when a newer one completes and rejects obsolete task events", () => {
    const events: CompanionEvent[] = [];
    const director = new CompanionDirector(configSchema.parse({ speech: "off" }), event => events.push(event));
    const send = (type: string, properties: unknown) => director.event({ type, properties });
    send("message.updated", { info: { sessionID: "s", id: "u", role: "user" } });
    send("message.part.updated", { part: { sessionID: "s", id: "prompt", messageID: "u", type: "text", text: "Исправь баг" } });
    send("message.updated", { info: { sessionID: "s", id: "a", role: "assistant", parentID: "u" } });
    const tool = (id: string, name: string, status: string, messageID = "a") => send("message.part.updated", {
      part: { sessionID: "s", id, messageID, type: "tool", tool: name, state: { status, input: { command: "npm test" } } },
    });
    tool("r", "read", "running"); tool("t", "bash", "running");
    expect(events.at(-1)).toMatchObject({ state: "working", activity: "test" });
    send("message.part.updated", { part: { sessionID: "s", id: "thinking", messageID: "a", type: "reasoning" } });
    expect(events.at(-1)).toMatchObject({ state: "working", activity: "test" });
    tool("t", "bash", "completed");
    expect(events.at(-1)).toMatchObject({ state: "working", activity: "read" });
    tool("r", "read", "error"); expect(events.at(-1)?.activity).toBeUndefined();
    tool("obsolete", "write", "running", "old"); expect(events.at(-1)?.activity).toBeUndefined();
    tool("again", "write", "running");
    send("message.part.removed", { sessionID: "s", partID: "again" });
    expect(events.at(-1)?.activity).toBeUndefined();
  });
});
