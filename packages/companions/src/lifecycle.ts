import { localVoiceSchema, specialistVoices, type CompanionConfig, type Role } from "./config.js";
import type { CompanionEvent } from "./director.js";
import type { DiagnosticSink } from "./diagnostic-log.js";
import { CharacterNames } from "./character-names.js";

interface Resident {
  event: CompanionEvent;
  recent: number;
  voice?: string;
  timer?: ReturnType<typeof setTimeout>;
}

/** Keep task, speech and visual lifetimes separate: only a drained, finished task may leave. */
export class CompanionLifecycle {
  private residents = new Map<string, Resident>();
  private retired = new Map<string, Set<string | undefined>>();
  private visible = new Set<string>();
  private pending = new Set<string>();
  private speaker?: string;
  private sequence = 0;
  private names = new CharacterNames();
  private closed = false;
  constructor(private config: CompanionConfig, private forward: (event: CompanionEvent) => void, private diagnostic?: DiagnosticSink) {}

  event(event: CompanionEvent): void {
    if (this.closed) return;
    const id = event.characterId;
    if (this.retired.get(id)?.has(event.taskId)) return;
    if (event.type === "remove") { this.retire(id); return; }
    let resident = this.residents.get(id);
    if (event.type === "state") {
      const sameInvocation = resident && (event.invocationId
        ? event.invocationId === resident.event.invocationId : event.taskId === resident.event.taskId);
      const name = sameInvocation && resident ? resident.event.name! : this.names.next(
        [...this.residents.values()].flatMap(entry => entry.event.name ? [entry.event.name] : []));
      event = { ...event, name };
      if (!resident || resident.event.state !== event.state || resident.event.role !== event.role || resident.event.taskId !== event.taskId) {
        this.diagnostic?.("lifecycle-state", { characterId: id, taskId: event.taskId, role: event.role, state: event.state });
      }
      if (!resident) {
        resident = { event, recent: ++this.sequence };
        this.residents.set(id, resident);
      } else {
        if (event.taskId && resident.event.taskId && event.taskId !== resident.event.taskId) {
          this.invalidate(id, resident.event.taskId);
          this.forward({ type: "stop", characterId: id });
        }
        resident.event = event; resident.recent = ++this.sequence;
      }
      clearTimeout(resident.timer); resident.timer = undefined;
      this.reconcile(id);
      this.schedule(id, resident);
    } else if (event.type === "speak" && resident) {
      if (event.taskId && resident.event.taskId && event.taskId !== resident.event.taskId) return;
      clearTimeout(resident.timer); resident.timer = undefined;
      resident.recent = ++this.sequence;
      this.reconcile();
      this.forward({ ...event, invocationId: event.invocationId ?? resident.event.invocationId,
        name: resident.event.name, voice: resident.voice });
      this.schedule(id, resident);
    } else if (event.type === "stop") this.forward(event);
  }

  /** Includes generation and queued speech, not just audible playback. */
  speechActivity(pending: Set<string>, speaker?: string): void {
    if (this.closed) return;
    this.pending = pending; this.speaker = speaker;
    this.reconcile();
    for (const [id, resident] of this.residents) this.schedule(id, resident);
  }

  voiceFor(id: string, role: Role): string {
    return this.residents.get(id)?.voice ?? this.config.tts.voices[role];
  }

  nameFor(id: string): string | undefined { return this.residents.get(id)?.event.name; }

  private schedule(id: string, resident: Resident): void {
    const finished = ["idle", "success", "error"].includes(resident.event.state ?? "working");
    if (!finished || this.pending.has(id)) {
      clearTimeout(resident.timer); resident.timer = undefined; return;
    }
    if (!resident.timer) {
      resident.timer = setTimeout(() => this.retire(id), 10_000);
      resident.timer.unref?.();
    }
  }

  private reconcile(changed?: string): void {
    const selected = [...this.residents.entries()].sort(([a, x], [b, y]) =>
      Number(b === this.speaker) - Number(a === this.speaker) || y.recent - x.recent).slice(0, this.config.maxVisible);
    const next = new Set(selected.map(([id]) => id));
    const previous = this.visible;
    this.visible = next;
    for (const id of previous) if (!next.has(id)) {
      this.diagnostic?.("lifecycle-remove", { characterId: id, reason: "visual-eviction" });
      // Eviction hides artwork but must not cancel queued speech or retire the task.
      this.forward({ type: "remove", characterId: id, visualOnly: true } as CompanionEvent);
      const resident = this.residents.get(id); if (resident) resident.voice = undefined;
    }
    const used = new Set(selected.flatMap(([, entry]) => entry.voice ? [entry.voice] : []));
    for (const [id, entry] of selected) {
      const preferred = specialistVoices[entry.event.appearance?.rig ?? ""] ?? this.config.tts.voices[entry.event.role ?? "coordinator"];
      if (id === changed && entry.voice !== preferred && !used.has(preferred)) {
        if (entry.voice) used.delete(entry.voice);
        entry.voice = preferred; used.add(preferred);
      }
      if (!entry.voice) {
        entry.voice = !used.has(preferred) ? preferred : localVoiceSchema.options.find(voice => !used.has(voice)) ?? preferred;
        used.add(entry.voice);
      }
      if (!previous.has(id)) this.diagnostic?.("lifecycle-visible", { characterId: id, taskId: entry.event.taskId, role: entry.event.role, voice: entry.voice, visible: next.size });
      if (!previous.has(id) || changed === id) this.forward({ ...entry.event, voice: entry.voice });
    }
    this.visible = next;
  }

  private retire(id: string): void {
    const entry = this.residents.get(id);
    if (!entry) return;
    this.diagnostic?.("lifecycle-remove", { characterId: id, taskId: entry.event.taskId, reason: "retired" });
    clearTimeout(entry.timer);
    this.residents.delete(id);
    this.invalidate(id, entry.event.taskId);
    this.visible.delete(id);
    // Hidden residents may still own queued synthesis and must be cancelled too.
    this.forward({ type: "remove", characterId: id, taskId: entry.event.taskId });
    this.reconcile();
  }

  private invalidate(id: string, taskId: string | undefined): void {
    const tasks = this.retired.get(id) ?? new Set<string | undefined>();
    tasks.add(taskId);
    if (tasks.size > 32) tasks.delete(tasks.values().next().value);
    this.retired.delete(id); this.retired.set(id, tasks);
    if (this.retired.size > 256) this.retired.delete(this.retired.keys().next().value!);
  }

  replay(): void { this.visible.clear(); this.reconcile(); }
  dispose(): void {
    this.closed = true;
    for (const entry of this.residents.values()) clearTimeout(entry.timer);
    this.residents.clear(); this.visible.clear();
  }
}
