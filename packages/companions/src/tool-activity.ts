export type ToolActivity = "read" | "search" | "edit" | "test" | "build" | "run" | "delegate";

/** Describe actual tools without exposing commands, tool output or private reasoning to the overlay. */
export function toolActivity(name: string, input: unknown): ToolActivity {
  const tool = name.toLowerCase();
  if (["task", "codex"].includes(tool)) return "delegate";
  if (["edit", "write", "apply_patch", "multiedit"].includes(tool)) return "edit";
  if (["read", "list", "webfetch"].includes(tool) || /context7|resolve.library|query.docs/.test(tool)) return "read";
  if (["grep", "glob", "websearch"].includes(tool) || /grep_app|grep\.app|search/.test(tool)) return "search";
  if (/playwright/.test(tool)) return "test";
  if (tool !== "bash" && tool !== "shell") return "run";
  const raw = input && typeof input === "object" && "command" in input && typeof input.command === "string"
    ? input.command.slice(0, 4000) : "";
  const command = raw.replace(/(['"`])(?:\\.|(?!\1).)*\1/gs, " ");
  // Only command heads count: `echo 'npm test'` is not a test invocation.
  const head = "(?:^|&&|;|\\|\\|)\\s*(?:[A-Za-z_][A-Za-z_0-9]*=\\S+\\s+)*";
  const packageManager = "(?:npm|pnpm|yarn|bun)(?:\\s+run)?\\s+";
  if (new RegExp(head + "(?:" + packageManager + "(?:test|check|lint|verify|e2e|qa)(?=[:\\s]|$)|(?:npx\\s+)?(?:vitest|jest|pytest|playwright)(?=\\s|$)|node\\s+--test(?=[=\\s]|$)|(?:cargo|go|swift)\\s+test(?=\\s|$)|(?:node|python3?)\\s+\\S*(?:test[-_.]|smoke[-_.])\\S*)", "i").test(command)) return "test";
  if (new RegExp(head + "(?:" + packageManager + "build(?=[:\\s]|$)|(?:swiftc|tsc|make|cmake)(?=\\s|$)|(?:cargo|go)\\s+build(?=\\s|$))", "i").test(command)) return "build";
  if (new RegExp(head + "(?:rg|grep|find)(?=\\s|$)", "i").test(command)) return "search";
  if (new RegExp(head + "(?:cat|head|tail|sed|ls)(?=\\s|$)", "i").test(command)) return "read";
  return "run";
}
