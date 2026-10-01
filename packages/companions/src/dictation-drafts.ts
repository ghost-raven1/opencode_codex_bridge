import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, chmod, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withDraftLock } from "./draft-lock.js";

export interface DictationDraft { id: string; text: string; createdAt: string }

/** Text-only, project-scoped history. A publish acknowledgement never deletes a draft. */
export class DictationDrafts {
  private drafts: DictationDraft[] = [];
  private serial = Promise.resolve();
  private publication = Promise.resolve();
  private recoveries = new Map<string, Promise<void>>();
  private constructor(private file: string) {}

  static async open(project: string, dataRoot = process.env.CODEXBRIDGE_DATA_DIR
    ?? join(homedir(), "Library", "Application Support", "CodexBridge")): Promise<DictationDrafts> {
    const canonical = await realpath(project).catch(() => project);
    const key = createHash("sha256").update(canonical).digest("hex");
    const store = new DictationDrafts(join(dataRoot, "dictation", key, "drafts.json"));
    await store.refresh();
    return store;
  }

  private async refresh(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(value) || !value.every(d => d && typeof d.id === "string" && typeof d.text === "string"
        && d.text.length <= 16_000 && typeof d.createdAt === "string")) throw new Error("Повреждена история диктовки; исходный файл сохранён.");
      this.drafts = value.slice(-20);
      await chmod(this.file, 0o600);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  list(): DictationDraft[] { return this.drafts.map(draft => ({ ...draft })); }
  get(id: string): DictationDraft | undefined { return this.list().find(draft => draft.id === id); }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.serial.then(operation);
    this.serial = task.then(() => undefined, () => undefined);
    return task;
  }

  private async persist(drafts: DictationDraft[]): Promise<void> {
    const directory = join(this.file, "..");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(drafts), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.file);
      this.drafts = drafts;
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  add(text: string): Promise<DictationDraft> {
    return this.enqueue(async () => {
      const trimmed = text.trim();
      if (!trimmed || trimmed.length > 16_000) throw new Error("Диктовка пуста или длиннее 16000 символов.");
      const draft = { id: randomUUID(), text: trimmed, createdAt: new Date().toISOString() };
      await withDraftLock(this.file, async () => {
        await this.refresh();
        await this.persist([...this.drafts, draft].slice(-20));
      });
      return draft;
    });
  }

  clear(): Promise<void> { return this.enqueue(() => withDraftLock(this.file, () => this.persist([]))); }

  /** Coalesce simultaneous explicit recovery clicks; reopening never publishes automatically. */
  recover(publish: (draft: DictationDraft) => Promise<void>, id?: string): Promise<void> {
    const key = id ?? this.drafts.at(-1)?.id ?? "latest";
    const inFlight = this.recoveries.get(key);
    if (inFlight) return inFlight;
    const lookup = this.enqueue(async () => {
      await this.refresh();
      const draft = id ? this.get(id) : this.drafts.at(-1);
      if (!draft) throw new Error("Черновик диктовки не найден.");
      return draft;
    });
    // Network publication never holds the persistence queue or its cross-process lease.
    const task = this.publication.catch(() => undefined).then(async () => publish(await lookup));
    void lookup.catch(() => undefined);
    this.publication = task;
    const recovery = task.finally(() => { this.recoveries.delete(key); });
    this.recoveries.set(key, recovery);
    return recovery;
  }
}
