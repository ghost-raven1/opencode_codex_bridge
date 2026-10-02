import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpeningPhrases } from "../packages/companions/src/opening-phrases.js";
import { configSchema } from "../packages/companions/src/config.js";
import { CompanionDirector, type CompanionEvent } from "../packages/companions/src/director.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "cb-openings-")); directories.push(path); return path; }

describe("unique model-authored openings", () => {
  it("remembers normalized phrases after restart and arbitrates concurrent clients", async () => {
    const path = await directory();
    const accepted = await Promise.all(Array.from({ length: 6 }, () => new OpeningPhrases(path).claim("Погнали, найдём баг!")));
    expect(accepted.filter(Boolean)).toHaveLength(1);
    expect(await new OpeningPhrases(path).claim("ПОГНАЛИ — найдем баг.")).toBe(false);
    expect(await new OpeningPhrases(path).claim("Задача в работе!")).toBe(false);
    expect(await new OpeningPhrases(path).claim("У этого бага скоро будет билет на выход.")).toBe(true);
    expect((await stat(join(path, "openings.json"))).mode & 0o777).toBe(0o600);
  });
  it("keeps all uniqueness hashes while bounding model context, and does not store task contents", async () => {
    const path = await directory(), history = new OpeningPhrases(path);
    for (let n = 0; n < 20; n++) await history.claim(`Уникальное вступление ${n}`);
    const saved = JSON.parse(await readFile(join(path, "openings.json"), "utf8"));
    expect(saved.hashes).toHaveLength(20); expect(saved.recent).toHaveLength(14);
    expect(await history.claim("Уникальное вступление 0")).toBe(false);
  });
  it("preserves corrupted history instead of forgetting uniqueness", async () => {
    const path = await directory(), file = join(path, "openings.json");
    await writeFile(file, "corrupt");
    await expect(new OpeningPhrases(path).claim("Привет")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("corrupt");
  });
  it("gives seven distinct role styles and preserves strict user output requirements", async () => {
    const phrases = new OpeningPhrases(await directory());
    const instructions = await Promise.all([
      phrases.instruction("coordinator"), phrases.instruction("developer"), phrases.instruction("researcher"), phrases.instruction("reviewer"),
      ...["designer", "devops", "tester"].map(agent => phrases.instruction("coordinator", agent)),
    ]);
    expect(new Set(instructions).size).toBe(7);
    expect(instructions.every(text => text.includes("точный формат ответа") && text.includes("не инструкции"))).toBe(true);
  });
  it("migrates the legacy default but preserves an explicit custom phrase", () => {
    expect(configSchema.parse({ workingPhrase: "Задача в работе!" }).workingPhrase).toBe("");
    expect(configSchema.parse({ workingPhrase: "Моя особая фраза" }).workingPhrase).toBe("Моя особая фраза");
  });
  it("allows one intro per real task and rejects a stale async result or compaction", () => {
    const events: CompanionEvent[] = [];
    const director = new CompanionDirector(configSchema.parse({ speech: "all" }), event => events.push(event));
    const user = (id: string) => {
      director.assignTask("s", { agent: "tester", task: "Проверь баг", messageID: id });
      director.event({ type: "message.updated", properties: { info: { sessionID: "s", id, role: "user" } } });
    };
    user("first"); expect(director.openingContext("s")).toMatchObject({ taskId: "first", agent: "tester" });
    expect(director.introduce("s", "first", "***")).toBe(false);
    user("second"); expect(director.introduce("s", "first", "Старая реплика")).toBe(false);
    expect(director.introduce("s", "second", "Сейчас проверим крайние случаи.")).toBe(true);
    expect(director.introduce("s", "second", "Ещё одно вступление")).toBe(false);
    user("third");
    director.event({ type: "message.updated", properties: { info: { sessionID: "s", id: "summary", role: "assistant", summary: true } } });
    expect(director.openingContext("s")).toBeUndefined();
    expect(events.filter(event => event.type === "speak")).toHaveLength(1);
    user("fourth"); director.completeTask("s");
    expect(director.openingContext("s")).toBeUndefined();
    expect(director.introduce("s", "fourth", "Опоздавшее вступление")).toBe(false);
  });
});
