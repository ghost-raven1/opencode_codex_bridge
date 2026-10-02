import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DiagnosticLog, type DiagnosticEvent } from "../packages/companions/src/diagnostic-log.js";

const temporary: string[] = [];
async function setup(maxBytes?: number) {
  const directory = await mkdtemp(join(tmpdir(), "codexbridge-diagnostics-")); temporary.push(directory);
  const project = join(directory, "private-project"); await mkdir(project);
  const dataRoot = join(directory, "private-data");
  return { directory, project, dataRoot, log: await DiagnosticLog.open(project, { dataRoot, maxBytes }) };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function contents(path: string): Promise<string> {
  return (await Promise.all([2, 1, 0].map(index => readFile(index ? `${path}.${index}` : path, "utf8").catch(() => "")))).join("");
}

describe("private companion diagnostics", () => {
  it("writes only allowlisted measurements and pseudonymous IDs with private file/directory modes", async () => {
    const t = await setup();
    t.log.record("speech-start", { characterId: "raw-character-secret", taskId: "raw-task-secret", audioId: "raw-audio-secret",
      engine: "local", voice: "Vivian", elapsedMs: 12.34567, text: "secret spoken phrase", token: "sk-secret",
      reasoning: "secret private reasoning", audio: "secret audio bytes", path: "/private/user/project.wav", confidence: NaN,
      state: "secret state", reason: "secret upstream error", message: "secret transcript",
      name: "secret companion name", invocationId: "secret invocation identity" });
    t.log.record("speech-end", { characterId: "raw-character-secret", phase: "end", elapsedMs: 20 });
    t.log.record("secret-event" as DiagnosticEvent, { text: "also secret" });
    expect(() => t.log.record("native-error", JSON.parse('{"__proto__":"secret","constructor":"secret","toString":"secret"}'))).not.toThrow();
    await t.log.flush();
    const text = await contents(t.log.path), entries = text.trim().split("\n").map(line => JSON.parse(line));
    expect(text).not.toMatch(/secret|project\.wav|private-project/);
    expect(entries).toHaveLength(4);
    expect(entries[1]).toMatchObject({ event: "speech-start", engine: "local", voice: "Vivian", elapsedMs: 12.346 });
    expect(entries[1].characterId).toMatch(/^[a-f0-9]{24}$/);
    expect(entries[1].characterId).toBe(entries[2].characterId);
    expect(entries[1]).not.toHaveProperty("name"); expect(entries[1]).not.toHaveProperty("invocationId");
    expect((await stat(t.log.path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(t.log.path))).mode & 0o777).toBe(0o700);
    await chmod(t.log.path, 0o644);
    const again = await DiagnosticLog.open(t.project, { dataRoot: t.dataRoot }); await again.flush();
    expect((await stat(t.log.path)).mode & 0o777).toBe(0o600);
  });
  it("retains at most three bounded files and serializes independent writers for the same project", async () => {
    const t = await setup(1024), second = await DiagnosticLog.open(t.project, { dataRoot: t.dataRoot, maxBytes: 1024 });
    for (let index = 0; index < 60; index++) {
      t.log.record("speech-queue", { pending: index, characterId: "first" });
      second.record("speech-queue", { pending: index, characterId: "second" });
    }
    await Promise.all([t.log.flush(), second.flush()]);
    const names = await readdir(dirname(t.log.path));
    expect(names.sort()).toEqual(["companions.jsonl", "companions.jsonl.1", "companions.jsonl.2"]);
    for (const name of names) {
      const file = await stat(join(dirname(t.log.path), name)); expect(file.size).toBeLessThanOrEqual(1024);
      expect(file.mode & 0o777).toBe(0o600);
    }
    const entries = (await contents(t.log.path)).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.length).toBeGreaterThan(1);
    expect(entries.at(-1)).toMatchObject({ event: "speech-queue", pending: 59 });
  });
  it("resolves project aliases consistently and isolates different projects outside their checkouts", async () => {
    const t = await setup(), link = join(t.directory, "project-alias"), project2 = join(t.directory, "second-project");
    await symlink(t.project, link); await mkdir(project2);
    const alias = await DiagnosticLog.open(link, { dataRoot: t.dataRoot }), second = await DiagnosticLog.open(project2, { dataRoot: t.dataRoot });
    expect(alias.path).toBe(t.log.path); expect(second.path).not.toBe(t.log.path);
    expect(t.log.path.startsWith(t.project + "/")).toBe(false);
    await Promise.all([t.log.flush(), alias.flush(), second.flush()]);
  });
  it("bounds pending diagnostics and reports drops without blocking the caller", async () => {
    const t = await setup();
    for (let index = 0; index < 2000; index++) t.log.record("speech-queue", { pending: index });
    await t.log.flush();
    const entries = (await contents(t.log.path)).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.length).toBeLessThanOrEqual(259);
    expect(entries.find(entry => entry.event === "log-overflow")?.dropped).toBeGreaterThan(1700);
  });
  it("contains write failures and stops retrying an unavailable destination", async () => {
    const t = await setup(); await t.log.flush(); await rm(t.log.path); await mkdir(t.log.path);
    expect(() => t.log.record("speech-queue", { pending: 1 })).not.toThrow(); await expect(t.log.flush()).resolves.toBeUndefined();
    expect(() => t.log.record("speech-queue", { pending: 2 })).not.toThrow(); await t.log.flush();
    expect(await readdir(t.log.path)).toEqual([]);
  });
});
