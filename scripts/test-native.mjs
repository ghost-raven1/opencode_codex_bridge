import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("Native regression tests require macOS");
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "codexbridge-native-tests-"));
try {
  for (const [name, sources, test] of [
    ["bubble", ["SpeechBubbleView.swift"], "test-speech-bubble.swift"],
    ["animation", ["CharacterMotion.swift"], "test-animation.swift"],
    ["character", ["CharacterView.swift", "CharacterMotion.swift", "SpeechBubbleView.swift", "SpriteCache.swift", "WindowState.swift"], "test-character-view.swift"],
  ]) {
    const binary = join(temporary, name);
    let result = spawnSync("swiftc", ["-swift-version", "5", "-module-cache-path", join(root, ".local/swift-cache"),
      "-framework", "AppKit", ...sources.map(source => join(root, "packages/companions/native", source)), join(root, "scripts", test), "-o", binary],
    { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${name} test build failed`);
    result = spawnSync(binary, name === "animation" ? [join(root, "packages/companions/assets")] : [], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${name} native regression failed`);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
