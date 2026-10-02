import { expect, it } from "vitest";
import { agentConfiguration } from "../scripts/lib/agent-config.mjs";

it("adds specialist subagents without overriding the caller's model or permission policy", () => {
  const roles = agentConfiguration();
  expect(Object.keys(roles).sort()).toEqual(["designer", "devops", "tester"]);
  for (const [name, role] of Object.entries(roles)) {
    expect(role.mode).toBe("subagent");
    expect(role.description).toBeTruthy();
    expect(role.prompt).toContain(name);
    // Omission is intentional: do not replace a project's stricter model/tool policy.
    for (const key of ["model", "variant", "permission", "tools"]) expect(role).not.toHaveProperty(key);
  }
});
