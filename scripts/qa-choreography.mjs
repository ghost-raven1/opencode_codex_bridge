import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rendererSources } from "./lib/native-sources.mjs";

// Exercise the production AppKit renderer without changing settings or capturing microphone audio.
const root = fileURLToPath(new URL("../", import.meta.url)), native = join(root, "packages/companions/native");
const output = join(root, ".local/choreography-native-qa"), temporary = mkdtempSync(join(tmpdir(), "choreography-qa-"));
const expansion = join(root, "packages/companions/assets/expansion");
const sources = rendererSources.filter(name => name !== "CharacterView.swift");
function rendererHash() {
  const hash = createHash("sha256");
  for (const name of rendererSources) hash.update(name).update(readFileSync(join(native, name)));
  for (const name of ["qa-choreography.mjs", "qa-choreography.swift", "lib/native-sources.mjs"]) {
    hash.update(name).update(readFileSync(join(root, "scripts", name)));
  }
  return hash.digest("hex");
}
function artworkHash() {
  const data = readFileSync(join(expansion, "choreography.json"));
  const hash = createHash("sha256").update(data).update(readFileSync(join(expansion, "skeletons.json")));
  for (const file of JSON.parse(data.toString("utf8")).runtimeFiles.sort()) hash.update(file).update(readFileSync(join(expansion, file)));
  return hash.digest("hex");
}
mkdirSync(output, { recursive: true });
try {
  rmSync(join(output, "report.json"), { force: true });
  const before = artworkHash();
  const rendererBefore = rendererHash();
  let view = readFileSync(join(native, "CharacterView.swift"), "utf8");
  for (const [from, to] of [
    ["final class CharacterView: NSView {", "final class CharacterView: NSView {\n    var auditPose: CharacterPose?\n    var auditReduced = false"],
    ['var reduced: Bool { CommandLine.arguments.contains("--reduce-motion") || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }', "var reduced: Bool { auditReduced }"],
    ["let posture = displayPosture(for: character, at: time)", "let posture = auditPose.map { PoseFrame(kind: $0) } ?? displayPosture(for: character, at: time)"],
  ]) {
    assert(view.includes(from), `Missing native QA hook: ${from}`); view = view.replace(from, to);
  }
  writeFileSync(join(temporary, "CharacterView.swift"), view);
  const binary = join(temporary, "qa-choreography");
  const compiled = spawnSync("swiftc", ["-O", "-swift-version", "5", "-module-cache-path", join(root, ".local/swift-cache"),
    "-framework", "AppKit", ...sources.map(name => join(native, name)), join(temporary, "CharacterView.swift"),
    join(root, "scripts/qa-choreography.swift"), "-o", binary], { stdio: "inherit" });
  assert.equal(compiled.status, 0, "Native choreography QA compilation failed");
  const rendered = spawnSync(binary, [join(root, "packages/companions/assets"), output], { stdio: "inherit" });
  assert.equal(rendered.status, 0, "Native choreography QA failed");
  assert.equal(artworkHash(), before, "Artwork changed during native QA; repeat after the role exports are frozen");
  assert.equal(rendererHash(), rendererBefore, "Renderer changed during native QA; repeat after the Swift sources are frozen");
  const reportPath = join(output, "report.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  writeFileSync(reportPath, JSON.stringify({ ...report, artworkSha256: before, rendererSha256: rendererBefore,
    checkedAt: new Date().toISOString() }, null, 2) + "\n");
} catch (error) {
  rmSync(join(output, "report.json"), { force: true });
  throw error;
} finally { rmSync(temporary, { recursive: true, force: true }); }
