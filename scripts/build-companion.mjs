import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

if (process.platform !== "darwin") throw new Error("Native companion build requires macOS and Xcode Command Line Tools");
const root = fileURLToPath(new URL("../", import.meta.url));
mkdirSync(`${root}.local/swift-cache`, { recursive: true });
const result = spawnSync("swiftc", ["-swift-version", "5", "-module-cache-path", `${root}.local/swift-cache`,
  "-framework", "AppKit", "-framework", "AVFoundation", "packages/companions/native/CharacterView.swift", "packages/companions/native/main.swift",
  "-o", "packages/companions/native/Companions"], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
