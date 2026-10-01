import type { Role } from "./config.js";

/** Task data comes from user messages or the parent's task-tool input, never assistant prose. */
export interface TaskAssignment {
  agent?: string;
  task: string;
  parentID?: string;
  messageID?: string;
}

const intents: [Role, RegExp][] = [
  ["coordinator", /(?<![\p{L}\p{N}_])(?:(?:write|create|prepare)\s+(?:(?:a|the)\s+)?(?:plan|roadmap)|plan(?:ning)?|coordinate|orchestrate|delegate|decompose|architect|план|спланир\p{L}*|(?:состав|напиш|напис)\p{L}*\s+план\p{L}*|планир\p{L}*|координир\p{L}*|распредел\p{L}*|декомпоз\p{L}*|разбей\p{L}*\s+(?:задач\p{L}*|работ\p{L}*)|разработ\p{L}*\s+архитектур\p{L}*)(?![\p{L}\p{N}_])/gu],
  ["developer", /(?<![\p{L}\p{N}_])(?:implement|build|add|write|create|fix|refactor|integrate|migrate|develop|реализ\p{L}*|добав\p{L}*|напиш\p{L}*|напис\p{L}*|исправ\p{L}*|почин\p{L}*|внедр\p{L}*|доработ\p{L}*|созда\p{L}*|собер\p{L}*|собрат\p{L}*|отрефактор\p{L}*|рефактор\p{L}*|мигрир\p{L}*)(?![\p{L}\p{N}_])/gu],
  ["researcher", /(?<![\p{L}\p{N}_])(?:research|search|find|investigate|explore|compare|look\s+up|analy[sz]e|исслед\p{L}*|найди|найти|поиск\p{L}*|изуч\p{L}*|сравн\p{L}*|разбер\p{L}*|разобра\p{L}*|проанализ\p{L}*)(?![\p{L}\p{N}_])/gu],
  ["reviewer", /(?<![\p{L}\p{N}_])(?:review|audit|verify|validate|test|inspect|check|ревью|аудит\p{L}*|провер\p{L}*|протест\p{L}*|тестирован\p{L}*)(?![\p{L}\p{N}_])/gu],
];

/** A small deterministic heuristic: the first requested action takes priority over later context. */
export function roleFromTask(task: string): Role | undefined {
  const text = task.slice(0, 16000).replace(/```[\s\S]*?```/g, " ").replace(/^\s*>.*$/gm, " ")
    .replace(/https?:\/\/\S+/g, " ").toLocaleLowerCase().replace(/ё/g, "е");
  let selected: { index: number; role: Role } | undefined;
  for (const [role, pattern] of intents) {
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(Math.max(0, match.index - 40), match.index);
      if (/(?:\bdo\s+not|\bdon't|\bnever|(?<!\p{L})не)\s+(?:\p{L}+\s+){0,2}$/u.test(before)) continue;
      if (!selected || match.index < selected.index) selected = { index: match.index, role };
      break;
    }
  }
  if (!selected) return undefined;
  // Looking for defects in a patch is review; looking for documentation remains research.
  if (selected.role === "researcher" && /^(?:найди|найти|find|search)(?!\p{L})/u.test(text.slice(selected.index)) &&
      /(?<!\p{L})(?:bugs?|defects?|regressions?|баг\p{L}*|дефект\p{L}*|регресси\p{L}*)/u.test(text)) return "reviewer";
  return selected.role;
}

/** Explicit per-agent configuration wins; generic built-in agents allow their task to choose a role. */
export function detectRole(input: TaskAssignment, overrides: Record<string, Role> = {}): Role {
  const agent = input.agent?.trim() ?? "";
  const normalized = agent.toLocaleLowerCase();
  const override = Object.hasOwn(overrides, agent) ? overrides[agent]
    : Object.hasOwn(overrides, normalized) ? overrides[normalized] : undefined;
  if (override) return override;
  const inferred = roleFromTask(input.task);
  if (inferred) return inferred;
  if (/(?:^|[-_\s])(?:review(?:er)?|audit(?:or)?|qa)(?:$|[-_\s])/u.test(normalized)) return "reviewer";
  if (/(?:^|[-_\s])(?:explore|research(?:er)?|search)(?:$|[-_\s])/u.test(normalized)) return "researcher";
  if (["build", "plan", "coordinator", "lead"].includes(normalized)) return "coordinator";
  if (["general", "developer", "code"].includes(normalized)) return "developer";
  return input.parentID ? "developer" : "coordinator";
}
