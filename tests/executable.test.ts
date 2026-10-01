import { afterEach, expect, it, vi } from "vitest";
import { codexExecutable } from "../packages/bridge/src/executable.js";

afterEach(() => vi.unstubAllGlobals());

it("launches Codex with Node inside the standalone OpenCode binary", () => {
  vi.stubGlobal("process", { ...process, execPath: "/usr/local/bin/opencode", versions: { ...process.versions, bun: "1.3.10" } });
  const executable = codexExecutable();
  expect(executable.command).toBe("node");
  expect(executable.args[0]).toMatch(/@openai\/codex\/bin\/codex\.js$/);
});

it("preserves the current Node runtime outside OpenCode", () => {
  const versions = { ...process.versions }; delete versions.bun;
  vi.stubGlobal("process", { ...process, versions, execPath: "/test/node" });
  expect(codexExecutable().command).toBe("/test/node");
});
