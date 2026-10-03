import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// Offscreen AppKit QA only: no model request, speech, microphone or persistent app settings.
if (process.platform !== "darwin") throw new Error("Companion motion QA requires macOS");
if (process.argv.includes("--help")) {
  console.log("Usage: npm run qa:motion -- [output-directory]\nRenders native animation frames without audio or microphone access.");
  process.exit(0);
}
const root = resolve(new URL("..", import.meta.url).pathname);
const native = join(root, "packages/companions/native");
const output = resolve(process.argv[2] ?? join(root, ".local/animation-qa"));
const assets = join(root, "packages/companions/assets");
const temporary = mkdtempSync(join(tmpdir(), "codexbridge-motion-qa-"));
mkdirSync(output, { recursive: true });
const files = ["manifest.json", "poses.json"].flatMap(name => Object.values(JSON.parse(readFileSync(join(assets, "expansion", name), "utf8")).characters)
  .flatMap(rig => [...rig.layers.map(layer => layer.file), rig.face.file]));
const sha = file => createHash("sha256").update(readFileSync(join(assets, "expansion", file))).digest("hex");
const before = Object.fromEntries([...new Set(files)].map(file => [file, sha(file)]));
try {
  let view = readFileSync(join(native, "CharacterView.swift"), "utf8");
  for (const [from, to] of [
    ["final class CharacterView: NSView {", `final class CharacterView: NSView {
    var auditPose: CharacterPose?
    var auditGesture: Double?
    var auditVariant: Int?
    var auditDepth: DepthPose?
    var auditReduced = false
    var auditActions: [TeamAction] { team.actions }
    func auditResetTeam() { team.reset() }`],
    ['var reduced: Bool { CommandLine.arguments.contains("--reduce-motion") || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }', "var reduced: Bool { auditReduced }"],
    ["let gesture = ambient[character.id]?.gestureStart", "let gesture = auditGesture.map { time - $0 } ?? ambient[character.id]?.gestureStart"],
    ["let posture = displayPosture(for: character, at: time)", "let posture = auditPose.map { PoseFrame(kind: $0) } ?? displayPosture(for: character, at: time)"],
    ["variant: (ambient[character.id]?.gestureIndex ?? 0) + character.motionSeed", "variant: auditVariant ?? ((ambient[character.id]?.gestureIndex ?? 0) + character.motionSeed)"],
    ["let depth = SpriteDepth.pose(", "let depth = auditDepth ?? SpriteDepth.pose("],
  ]) {
    assert(view.includes(from), `Missing motion QA hook: ${from}`);
    view = view.replace(from, to);
  }
  writeFileSync(join(temporary, "CharacterView.swift"), view);
  let work = readFileSync(join(native, "WorkMotion.swift"), "utf8");
  for (const [from, to] of [
    ["guard elapsed < duration else", "guard (MotionAudit.progress ?? (elapsed / duration)) < 1 else"],
    ["let p = elapsed / duration, envelope", "let p = MotionAudit.progress ?? (elapsed / duration), envelope"],
    ["let variant = (cycle + Int(seed % 4)) % 4", "let variant = MotionAudit.variant ?? ((cycle + Int(seed % 4)) % 4)"],
  ]) {
    assert(work.includes(from), `Missing work QA hook: ${from}`);
    work = work.replace(from, to);
  }
  writeFileSync(join(temporary, "WorkMotion.swift"), work);
  const sources = ["CharacterMotion", "LayeredMotion", "LayeredRig", "PoseAnimation", "IdleMotion", "TeamMotion", "SpriteTransition",
    "MusicRhythm", "MusicMotion", "CharacterBadgeView", "SpeechBubbleView", "SpriteCache", "SpriteDepth"];
  const binary = join(temporary, "qa-motion");
  const compiled = spawnSync("swiftc", ["-O", "-swift-version", "5", "-module-cache-path", join(root, ".local/swift-cache"),
    "-framework", "AppKit", ...sources.map(name => join(native, name + ".swift")), join(temporary, "CharacterView.swift"),
    join(temporary, "WorkMotion.swift"), join(root, "scripts/qa-companion-motion.swift"), "-o", binary], { stdio: "inherit" });
  assert.equal(compiled.status, 0, "Motion QA build failed");
  const rendered = spawnSync(binary, [assets, output], { stdio: "inherit" });
  assert.equal(rendered.status, 0, `Motion QA failed (${rendered.signal ?? rendered.status})`);
  const after = Object.fromEntries(Object.keys(before).map(file => [file, sha(file)]));
  assert.deepEqual(after, before, "QA changed the source artwork");
  writeFileSync(join(output, "source-check.json"), JSON.stringify({ unchanged: true, hashes: before }, null, 2) + "\n");
} finally { rmSync(temporary, { recursive: true, force: true }); }
