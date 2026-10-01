import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionLifecycle } from "../packages/companions/src/lifecycle.js";
import { DictationDrafts } from "../packages/companions/src/dictation-drafts.js";
import { configSchema } from "../packages/companions/src/config.js";
import type { CompanionEvent } from "../packages/companions/src/director.js";

const roots: string[] = [];
async function dataRoot() {
  const path = await mkdtemp(join(tmpdir(), "codexbridge-audit-")); roots.push(path); return path;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("lifecycle independent race audit", () => {
  it.each(["state", "stop", "remove"] as const)("ignores a delayed %s event for the previous task", type => {
    const forward = vi.fn(), lifecycle = new CompanionLifecycle(configSchema.parse({}), forward);
    try {
      lifecycle.event({ type: "state", characterId: "agent", taskId: "old", role: "reviewer", state: "working" });
      lifecycle.event({ type: "state", characterId: "agent", taskId: "new", role: "developer", state: "working" });
      forward.mockClear();
      lifecycle.event({ type, characterId: "agent", taskId: "old", state: "success", role: "reviewer" });
      expect(forward).not.toHaveBeenCalled();
      lifecycle.event({ type: "speak", characterId: "agent", taskId: "new", text: "Новая задача" });
      expect(forward).toHaveBeenLastCalledWith(expect.objectContaining({ type: "speak", taskId: "new" }));
    } finally { lifecycle.dispose(); }
  });

  it("forwards a real removal for a hidden character so its queued speech is cancelled", () => {
    const forward = vi.fn(), lifecycle = new CompanionLifecycle(configSchema.parse({ maxVisible: 1 }), forward);
    try {
      for (const id of ["hidden", "visible"]) lifecycle.event({ type: "state", characterId: id, taskId: "task", state: "working" });
      expect(forward).toHaveBeenCalledWith(expect.objectContaining({ type: "remove", characterId: "hidden", visualOnly: true }));
      forward.mockClear();
      lifecycle.event({ type: "remove", characterId: "hidden", taskId: "task" });
      expect(forward.mock.calls.some(([event]: [CompanionEvent & { visualOnly?: boolean }]) =>
        event.type === "remove" && event.characterId === "hidden" && !event.visualOnly)).toBe(true);
    } finally { lifecycle.dispose(); }
  });
});

describe("draft persistence independent race audit", () => {
  it("does not coalesce requests to insert two different drafts", async () => {
    const store = await DictationDrafts.open("/project", await dataRoot());
    const a = await store.add("Первый"), b = await store.add("Второй");
    let release!: () => void;
    const publish = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }))
      .mockResolvedValue(undefined);
    const first = store.recover(publish, a.id);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const second = store.recover(publish, b.id);
    release(); await Promise.all([first, second]);
    expect(publish.mock.calls.map(([draft]) => draft.id)).toEqual([a.id, b.id]);
  });

  it("retains drafts written by another store instance for the same project", async () => {
    const root = await dataRoot();
    const a = await DictationDrafts.open("/project", root), b = await DictationDrafts.open("/project", root);
    await a.add("Из первого окна"); await b.add("Из второго окна");
    const reopened = await DictationDrafts.open("/project", root);
    expect(reopened.list().map(draft => draft.text)).toEqual(["Из первого окна", "Из второго окна"]);
  });

  it("persists new dictation while an earlier publish acknowledgement is stalled", async () => {
    const store = await DictationDrafts.open("/project", await dataRoot()); await store.add("Старый черновик");
    let release!: () => void;
    const publish = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const recovery = store.recover(publish);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const saving = store.add("Новая запись");
    try {
      await vi.waitFor(() => expect(store.list().some(draft => draft.text === "Новая запись")).toBe(true), { timeout: 500 });
    } finally { release(); await Promise.all([recovery, saving]); }
  });
});
