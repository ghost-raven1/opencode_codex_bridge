import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationDrafts } from "../packages/companions/src/dictation-drafts.js";
const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), "cb-drafts-")); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("durable dictation", () => {
  it("keeps only 20 text drafts, atomically written with private permissions", async () => {
    const dir = await root(), store = await DictationDrafts.open("/one", dir);
    await Promise.all(Array.from({ length: 24 }, (_, i) => store.add(`Текст ${i}`)));
    expect(store.list()).toHaveLength(20);
    expect(store.list()[0]?.text).toBe("Текст 4");
    const project = (await readdir(join(dir, "dictation")))[0]!;
    const path = join(dir, "dictation", project, "drafts.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, "dictation", project))).toEqual(["drafts.json"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(store.list());
  });
  it("survives failed insertion and restart without automatic publication; projects remain separate", async () => {
    const dir = await root(), a = await DictationDrafts.open("/one", dir);
    const draft = await a.add("Не потеряй меня");
    const publish = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    await expect(a.recover(publish, draft.id)).rejects.toThrow("offline");
    const reopened = await DictationDrafts.open("/one", dir);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(reopened.list()).toEqual([draft]);
    expect((await DictationDrafts.open("/two", dir)).list()).toEqual([]);
    await reopened.recover(publish);
    expect(reopened.list()).toEqual([draft]); // HTTP 200 isn't insertion acknowledgement.
    await reopened.clear();
    expect((await DictationDrafts.open("/one", dir)).list()).toEqual([]);
  });
  it("coalesces duplicate clicks while one recovery is in flight", async () => {
    const store = await DictationDrafts.open("/one", await root()); await store.add("Повтор");
    let release!: () => void;
    const publish = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const first = store.recover(publish), second = store.recover(publish);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    release(); await Promise.all([first, second]);
  });
});
