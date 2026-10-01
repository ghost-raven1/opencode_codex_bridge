import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** A unique owner name prevents a delayed release/reclaim from deleting a replacement lock. */
async function release(path: string, owner: string): Promise<void> {
  try { await unlink(join(path, owner)); }
  catch (error) { if (code(error) === "ENOENT") return; throw error; }
  try { await rmdir(path); }
  catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) throw error; }
}

async function reclaim(path: string): Promise<void> {
  let owners: string[];
  try { owners = await readdir(path); }
  catch (error) { if (code(error) === "ENOENT") return; throw error; }
  if (owners.length !== 1) return;
  const owner = owners[0]!, match = owner.match(/^(\d+)\.[a-f0-9-]{36}$/);
  if (!match) return;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try { process.kill(pid, 0); }
  catch (error) { if (code(error) === "ESRCH") await release(path, owner); }
}

/** Install a pre-populated directory atomically; a live owner always makes it nonempty. */
export async function withDraftLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const path = `${file}.lock`, candidate = `${path}.${randomUUID()}.tmp`;
  const owner = `${process.pid}.${randomUUID()}`, deadline = Date.now() + 5000;
  await mkdir(candidate, { mode: 0o700 });
  try {
    await writeFile(join(candidate, owner), "", { mode: 0o600, flag: "wx" });
    while (true) {
      try { await rename(candidate, path); break; }
      catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(code(error) ?? "")) throw error; }
      await reclaim(path);
      if (Date.now() > deadline) throw new Error("История диктовки занята другим процессом. Повтори сохранение.");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    try { return await operation(); }
    finally { await release(path, owner); }
  } finally { await rm(candidate, { recursive: true, force: true }); }
}
