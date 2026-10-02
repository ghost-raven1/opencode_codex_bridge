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
    ["depth", ["SpriteDepth.swift"], "test-sprite-depth.swift"],
    ["bubble", ["SpeechBubbleView.swift"], "test-speech-bubble.swift"],
    ["animation", ["CharacterMotion.swift"], "test-animation.swift"],
    ["character", ["CharacterView.swift", "CharacterMotion.swift", "LayeredMotion.swift", "LayeredRig.swift", "WorkMotion.swift", "MusicRhythm.swift", "MusicMotion.swift", "CharacterBadgeView.swift", "SpeechBubbleView.swift", "SpriteCache.swift", "SpriteDepth.swift", "WindowState.swift"], "test-character-view.swift"],
    ["render-clear", ["CharacterView.swift", "CharacterMotion.swift", "LayeredMotion.swift", "LayeredRig.swift", "WorkMotion.swift", "MusicRhythm.swift", "MusicMotion.swift", "CharacterBadgeView.swift", "SpeechBubbleView.swift", "SpriteCache.swift", "SpriteDepth.swift"], "test-render-clear.swift"],
    ["layered", ["LayeredMotion.swift", "CaptionState.swift"], "test-layered.swift"],
    ["rig", ["LayeredRig.swift", "LayeredMotion.swift", "WorkMotion.swift", "CharacterMotion.swift", "SpriteCache.swift", "SpriteDepth.swift"], "test-rig.swift"],
    ["work", ["WorkMotion.swift"], "test-work-motion.swift"],
    ["music", ["MusicRhythm.swift", "MusicMotion.swift"], "test-music.swift"],
    ["music-control", ["MusicRhythm.swift", "MusicControl.swift"], "test-music-control.swift"],
    ["voice-commands", ["VoiceCommands.swift"], "test-voice-commands.swift"],
    ["scale", ["ScaleControl.swift"], "test-scale.swift"],
    ["speech", ["NativeSpeech.swift", "NativeAudioStream.swift", "NativeAudioEngine.swift"], "test-native-speech.swift"],
    ["speech-stream", ["NativeSpeech.swift", "NativeAudioStream.swift", "NativeAudioEngine.swift"], "test-native-audio-stream.swift"],
    ["speech-status", ["NativeSpeechStatus.swift"], "test-native-speech-status.swift"],
  ]) {
    const binary = join(temporary, name);
    let result = spawnSync("swiftc", ["-swift-version", "5", "-module-cache-path", join(root, ".local/swift-cache"),
      "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`,
      "-framework", "AppKit", ...sources.map(source => join(root, "packages/companions/native", source)), join(root, "scripts", test), "-o", binary],
    { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${name} test build failed`);
    const args = name === "animation" ? [join(root, "packages/companions/assets")]
      : name === "rig" ? [join(root, "packages/companions/assets/expansion")] : [];
    result = spawnSync(binary, args, { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${name} native regression failed`);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
