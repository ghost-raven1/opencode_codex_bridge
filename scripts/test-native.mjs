import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeTestSources, rendererSources } from "./lib/native-sources.mjs";

if (process.platform !== "darwin") throw new Error("Native regression tests require macOS");
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "codexbridge-native-tests-"));
try {
  for (const [name, sources, test] of [
    ["depth", ["SpriteDepth.swift", "SpriteCache.swift"], "test-sprite-depth.swift"],
    ["caption", ["CaptionState.swift", "SpeechReveal.swift"], "test-caption-state.swift"],
    ["bubble", ["SpeechBubbleView.swift"], "test-speech-bubble.swift"],
    ["transitions", ["SpriteTransition.swift"], "test-sprite-transitions.swift"],
    ["team", ["TeamMotion.swift", "CharacterMotion.swift", "WorkMotion.swift"], "test-team-motion.swift"],
    ["animation", ["CharacterMotion.swift"], "test-animation.swift"],
    ["character", [...rendererSources, "WindowState.swift"], "test-character-view.swift"],
    ["render-clear", rendererSources, "test-render-clear.swift"],
    ["layered", ["LayeredMotion.swift", "CaptionState.swift", "SpeechReveal.swift"], "test-layered.swift"],
    ["skeleton", ["LayeredRig.swift", "SkeletalRig.swift", "SkeletalMotion.swift", "LayeredMotion.swift", "WorkMotion.swift", "CharacterMotion.swift", "SpriteCache.swift", "SpriteDepth.swift"], "test-skeleton.swift"],
    ["skeletal-animation", ["LayeredRig.swift", "SkeletalRig.swift", "SkeletalMotion.swift", "LayeredMotion.swift", "WorkMotion.swift", "StateMotion.swift", "IdleMotion.swift", "CharacterMotion.swift", "PoseAnimation.swift", "SpriteCache.swift", "SpriteDepth.swift"], "test-skeletal-animation.swift"],
    ["rig", ["LayeredRig.swift", "LayeredMotion.swift", "WorkMotion.swift", "ActionMotion.swift", "CharacterMotion.swift", "SpriteCache.swift", "SpriteDepth.swift"], "test-rig.swift"],
    ["actions", ["WorkMotion.swift", "ActionMotion.swift"], "test-action-motion.swift"],
    ["gesture-interruptions", ["WorkMotion.swift", "StateMotion.swift", "TeamMotion.swift", "CharacterMotion.swift"], "test-gesture-interruptions.swift"],
    ["state", ["WorkMotion.swift", "StateMotion.swift"], "test-state-motion.swift"],
    ["work", ["WorkMotion.swift", "ActionMotion.swift", "IdleMotion.swift"], "test-work-motion.swift"],
    ["poses", rendererSources, "test-poses.swift"],
    ["choreography", ["PoseAnimation.swift", "PoseChoreography.swift", "MusicRhythm.swift", "MusicMotion.swift"], "test-choreography.swift"],
    ["music", ["MusicRhythm.swift", "MusicMotion.swift"], "test-music.swift"],
    ["music-control", ["MusicRhythm.swift", "MusicControl.swift"], "test-music-control.swift"],
    ["voice-commands", ["VoiceCommands.swift"], "test-voice-commands.swift"],
    ["voice-wake", ["VoiceCommands.swift", "WakeWord.swift", "SpeechCapture.swift", "MicrophoneTap.swift", "NativeDictation.swift", "WakeControl.swift"], "test-voice-wake.swift"],
    ["scale", ["ScaleControl.swift"], "test-scale.swift"],
    ["speech", ["NativeSpeech.swift", "NativeAudioStream.swift", "NativeAudioEngine.swift"], "test-native-speech.swift"],
    ["speech-stream", ["NativeSpeech.swift", "NativeAudioStream.swift", "NativeAudioEngine.swift"], "test-native-audio-stream.swift"],
    ["speech-status", ["NativeSpeechStatus.swift"], "test-native-speech-status.swift"],
  ]) {
    const binary = join(temporary, name);
    let result = spawnSync("swiftc", ["-O", "-swift-version", "5", "-module-cache-path", join(root, ".local/swift-cache"),
      "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`,
      "-framework", "AppKit", ...nativeTestSources(sources)
        .map(source => join(root, "packages/companions/native", source)), join(root, "scripts", test), "-o", binary],
    { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${name} test build failed`);
    const args = name === "animation" ? [join(root, "packages/companions/assets")]
      : ["rig", "skeleton", "skeletal-animation"].includes(name) ? [join(root, "packages/companions/assets/expansion")] : [];
    result = spawnSync(binary, args, { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${name} native regression failed`);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
