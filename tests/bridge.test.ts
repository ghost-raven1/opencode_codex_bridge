import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { runCodex } from "../packages/bridge/src/run.js";

const fixture = fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url));
const run = (prompt: string, extra: Partial<Parameters<typeof runCodex>[0]> = {}) => runCodex({
  prompt, cwd: process.cwd(), command: process.execPath, commandArgs: [fixture], timeoutMs: 2000, ...extra,
});
describe("Codex stdio bridge", () => {
  it("handles completion before the turn/start response", async () => {
    expect(await run("ok")).toMatchObject({ status: "completed", text: "done", threadId: "thread-1" });
  });
  it("decodes split UTF-8 and does not duplicate final text", async () => {
    const deltas: string[] = [];
    expect((await run("split", { onText: s => deltas.push(s) })).text).toBe("こんにちは, Лёха");
    expect(deltas.join("")).toBe("こんにちは, Лёха");
  });
  it("keeps failed turns failed", async () => {
    expect(await run("failed")).toMatchObject({ status: "failed", error: "provider unavailable" });
  });
  it.each(["crash", "malformed", "overflow"])("rejects %s without hanging", async mode => {
    await expect(run(mode)).rejects.toThrow();
  });
  it("cancels a running process", async () => {
    const controller = new AbortController();
    const task = run("hang", { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(task).rejects.toThrow(/cancelled|closed/i);
  });
  it("enforces a total deadline", async () => {
    await expect(run("hang", { timeoutMs: 100 })).rejects.toThrow();
  });
  it("rejects already aborted requests", async () => {
    await expect(run("ok", { signal: AbortSignal.abort() })).rejects.toThrow();
  });
  it("reports missing executable", async () => {
    await expect(run("ok", { command: "/missing/codex" })).rejects.toThrow(/ENOENT/);
  });
  it("declines OS commands without a host approval channel", async () => {
    expect((await run("approval-command")).text).toBe('{"decision":"decline"}');
  });
  it("declines when OpenCode denies approval", async () => {
    expect((await run("approval-command", { approve: async () => { throw new Error("denied"); } })).text)
      .toBe('{"decision":"decline"}');
  });
  it("accepts only the individual command after host approval", async () => {
    expect((await run("approval-command", { approve: async request => {
      expect(request.details.command).toBe("touch /tmp/requested"); return true;
    } })).text).toBe('{"decision":"accept"}');
  });
  it("grants requested permissions for one turn", async () => {
    expect(JSON.parse((await run("approval-permissions", { approve: async () => true })).text))
      .toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
  });
  it("returns an empty grant on denial", async () => {
    expect(JSON.parse((await run("approval-permissions")).text)).toEqual({ permissions: {}, scope: "turn" });
  });
  it("refuses to resume a thread in another project", async () => {
    await expect(run("ok", { threadId: "other", cwd: "/tmp" })).rejects.toThrow(/another project/);
  });
  it("can resume a thread in this project", async () => {
    expect((await run("ok", { threadId: "thread-1" })).status).toBe("completed");
  });
  it("rejects concurrent turns in the same resumed thread", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const first = run("hang", { threadId: "shared-thread", signal: controller.signal, onText: started });
    const failure = expect(first).rejects.toThrow();
    await ready;
    await expect(run("ok", { threadId: "shared-thread" })).rejects.toThrow(/active turn/);
    controller.abort();
    await failure;
    expect((await run("ok", { threadId: "shared-thread" })).status).toBe("completed");
  });
});
