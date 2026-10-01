import { describe, expect, it } from "vitest";
import { detectRole, roleFromTask } from "../packages/companions/src/role-detection.js";

describe("task-based companion roles", () => {
  it.each([
    ["Проверь патч и найди регрессии", "reviewer"],
    ["Сделай ревью изменений", "reviewer"],
    ["Найди баги в изменениях", "reviewer"],
    ["Review the diff for security defects", "reviewer"],
    ["Run a code audit", "reviewer"],
    ["Test the login flow", "reviewer"],
    ["Исследуй документацию macOS Speech", "researcher"],
    ["Найди подходящий планировщик", "researcher"],
    ["Compare official API documentation", "researcher"],
    ["Investigate the cause of intermittent failures", "researcher"],
    ["Исправь ошибку в bridge", "developer"],
    ["Добавь определение роли агента", "developer"],
    ["Implement role detection and then review it", "developer"],
    ["Write regression tests", "developer"],
    ["Составь план миграции", "coordinator"],
    ["Напиши план реализации", "coordinator"],
    ["Write a plan for the migration", "coordinator"],
    ["Разбей задачу между агентами", "coordinator"],
    ["Plan implementation stages", "coordinator"],
    ["Coordinate the child agents", "coordinator"],
  ])("maps %s to %s", (task, role) => expect(roleFromTask(task)).toBe(role));

  it("lets generic agents follow their actual task", () => {
    expect(detectRole({ agent: "general", task: "Research the API", parentID: "root" })).toBe("researcher");
    expect(detectRole({ agent: "build", task: "Review this patch" })).toBe("reviewer");
  });
  it("gives explicit user configuration the highest priority", () => {
    expect(detectRole({ agent: "my-agent", task: "Implement auth" }, { "my-agent": "reviewer" })).toBe("reviewer");
    expect(detectRole({ agent: "general", task: "Find docs" }, { general: "developer" })).toBe("developer");
  });
  it("keeps built-in semantics when a task has no clear intent", () => {
    expect(detectRole({ agent: "build", task: "Продолжай" })).toBe("coordinator");
    expect(detectRole({ agent: "plan", task: "Продолжай" })).toBe("coordinator");
    expect(detectRole({ agent: "explore", task: "Продолжай" })).toBe("researcher");
    expect(detectRole({ agent: "security-reviewer", task: "Продолжай" })).toBe("reviewer");
    expect(detectRole({ task: "Сделай задачу" })).toBe("coordinator");
    expect(detectRole({ parentID: "root", task: "Сделай задачу" })).toBe("developer");
  });
  it("ignores code fences, quoted instructions and explicitly negated work", () => {
    expect(roleFromTask("```\nImplement all code\n```\nReview the change")).toBe("reviewer");
    expect(roleFromTask("> Implement all code\nResearch the API")).toBe("researcher");
    expect(roleFromTask("Do not implement; research the options")).toBe("researcher");
    expect(roleFromTask("Не исправляй код, только проверь патч")).toBe("reviewer");
  });
});
