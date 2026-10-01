import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  afterRead: undefined as undefined | ((path: string, owners: string[]) => Promise<void>),
  beforeUnlink: undefined as undefined | ((path: string) => Promise<void>),
  beforeRmdir: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs,
    readdir: async (path: string) => { const result = await fs.readdir(path); await hooks.afterRead?.(path, result); return result; },
    unlink: async (path: string) => { await hooks.beforeUnlink?.(path); return fs.unlink(path); },
    rmdir: async (path: string) => { await hooks.beforeRmdir?.(path); return fs.rmdir(path); },
  };
});
import { withDraftLock } from "../packages/companions/src/draft-lock.js";

const roots: string[] = [];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function target() { const root = await mkdtemp(join(tmpdir(), "cb-draft-lock-")); roots.push(root); return join(root, "drafts.json"); }
afterEach(async () => {
  hooks.afterRead = hooks.beforeUnlink = hooks.beforeRmdir = undefined;
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("cross-process draft write lock", () => {
  it("serializes concurrent writers and removes every temporary lock", async () => {
    const file = await target(); let count = 0;
    await Promise.all(Array.from({ length: 8 }, () => withDraftLock(file, async () => {
      const before = count; await new Promise(resolve => setTimeout(resolve, 2)); count = before + 1;
    })));
    expect(count).toBe(8);
    expect(await readdir(join(file, ".."))).toEqual([]);
  });

  it("releases ownership when the protected write fails", async () => {
    const file = await target();
    await expect(withDraftLock(file, async () => { throw new Error("Write failed"); })).rejects.toThrow("Write failed");
    await expect(withDraftLock(file, async () => "next write")).resolves.toBe("next write");
  });

  it("does not reclaim a new live owner using a concurrently captured dead-owner snapshot", async () => {
    const file = await target(), lock = `${file}.lock`, deadPID = 2_147_483_647;
    expect(() => process.kill(deadPID, 0)).toThrow();
    const stale = `${deadPID}.${randomUUID()}`;
    await mkdir(lock); await writeFile(join(lock, stale), "");
    const bothRead = deferred(), firstEntered = deferred(), releaseFirst = deferred(), observedLive = deferred(), overlapped = deferred();
    let snapshots = 0, staleUnlinks = 0, entered = 0;
    hooks.afterRead = async (path, owners) => {
      if (path !== lock) return;
      if (owners.includes(stale)) {
        if (++snapshots === 2) bothRead.resolve();
        await bothRead.promise;
      } else if (owners.length === 1) observedLive.resolve();
    };
    hooks.beforeUnlink = async path => {
      if (path === join(lock, stale) && ++staleUnlinks === 2) await firstEntered.promise;
    };
    const operation = async () => {
      if (++entered === 1) { firstEntered.resolve(); await releaseFirst.promise; }
      else overlapped.resolve();
    };
    const writers = [withDraftLock(file, operation), withDraftLock(file, operation)];
    try {
      const state = await Promise.race([observedLive.promise.then(() => "waiting"), overlapped.promise.then(() => "overlap")]);
      expect(state).toBe("waiting"); expect(entered).toBe(1);
    } finally { releaseFirst.resolve(); await Promise.all(writers); }
    expect(entered).toBe(2); expect(staleUnlinks).toBe(2);
  });

  it("cannot remove a replacement lock installed between owner unlink and directory removal", async () => {
    const file = await target(), lock = `${file}.lock`, removing = deferred(), releaseRemoval = deferred(), entered = deferred(), releaseSecond = deferred();
    let removals = 0;
    hooks.beforeRmdir = async path => {
      if (path === lock && ++removals === 1) { removing.resolve(); await releaseRemoval.promise; }
    };
    const first = withDraftLock(file, async () => {});
    await removing.promise;
    const second = withDraftLock(file, async () => { entered.resolve(); await releaseSecond.promise; });
    try {
      await entered.promise; releaseRemoval.resolve(); await first;
      expect(await readdir(lock)).toHaveLength(1);
    } finally { releaseRemoval.resolve(); releaseSecond.resolve(); await Promise.all([first, second]); }
  });
});
