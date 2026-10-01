import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";

if (process.platform !== "darwin") throw new Error("Native companion build requires macOS and Xcode Command Line Tools");
const root = fileURLToPath(new URL("../", import.meta.url));
const native = `${root}packages/companions/native`;
const bundle = `${native}/CodexBridge Companions.app`;
mkdirSync(`${root}.local/swift-cache`, { recursive: true });
mkdirSync(`${bundle}/Contents/MacOS`, { recursive: true });
mkdirSync(`${bundle}/Contents/Resources`, { recursive: true });
// LaunchServices gives the app its own privacy identity; keep its artwork inside its signed bundle.
for (const name of ["team-atlas.png", "head-atlas.png", "body-atlas.png", "poses.png", "transitions.png"]) {
  const source = `${root}packages/companions/assets/${name}`;
  const target = `${bundle}/Contents/Resources/${name}`;
  if (existsSync(source)) copyFileSync(source, target);
  else rmSync(target, { force: true });
}
writeFileSync(`${bundle}/Contents/Info.plist`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.codexbridge.companions</string>
<key>CFBundleName</key><string>CodexBridge Companions</string>
<key>CFBundleDisplayName</key><string>CodexBridge Companions</string>
<key>CFBundleExecutable</key><string>Companions</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSMicrophoneUsageDescription</key><string>Диктовка по вашему нажатию в меню CodexBridge. Запись останавливается через 60 секунд.</string>
<key>NSSpeechRecognitionUsageDescription</key><string>macOS преобразует вашу диктовку в текст для строки ввода OpenCode. Текст не отправляется автоматически.</string>
</dict></plist>
`);
const result = spawnSync("swiftc", ["-swift-version", "5", "-module-cache-path", `${root}.local/swift-cache`,
  "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`,
  "-framework", "AppKit", "-framework", "AVFoundation", "-framework", "Speech",
  ...["CharacterView.swift", "WindowState.swift", "NativeSpeech.swift", "NativeDictation.swift", "main.swift"].map(name => `${native}/${name}`),
  "-o", `${bundle}/Contents/MacOS/Companions`], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
const signed = spawnSync("codesign", ["--force", "--sign", "-", "--identifier", "dev.codexbridge.companions", bundle], { cwd: root, stdio: "inherit" });
if (signed.status !== 0) process.exit(signed.status ?? 1);
// Preserve the old executable path for existing locally generated profiles.
rmSync(`${native}/Companions`, { force: true });
symlinkSync("CodexBridge Companions.app/Contents/MacOS/Companions", `${native}/Companions`);
