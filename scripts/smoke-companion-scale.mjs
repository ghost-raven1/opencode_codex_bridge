import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startNativeHost } from "../packages/companions/dist/native-host.js";

if (process.platform !== "darwin") throw new Error("Companion scale smoke requires macOS");
const root = fileURLToPath(new URL("../", import.meta.url)), exec = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), "codexbridge-scale-smoke-"));
const bundle = join(temporary, "Scale Smoke.app"), identifier = `dev.codexbridge.scale.smoke.${Date.now()}`;
const results = [], errors = [];
let host, observer, onClosed, closed;

function wait(name, matches, trigger = () => host.send({ type: "window-status" })) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observer = undefined; reject(new Error(`${name} timed out`)); }, 6000);
    observer = event => {
      if (!matches(event)) return;
      clearTimeout(timer); observer = undefined; results.push({ name, ...event }); resolve(event);
    };
    trigger();
  });
}

async function launch(scale) {
  closed = new Promise(resolve => { onClosed = resolve; });
  host = await startNativeHost(join(bundle, "Contents/MacOS/Companions"), [
    "--atlas", join(bundle, "Contents/Resources/team-atlas.png"), "--reduce-motion",
    "--config", JSON.stringify({ enabled: true, speech: "off", dictation: false, maxVisible: 4, scale }),
  ], event => {
    if (event.type === "closed") onClosed?.();
    if (event.type === "error") errors.push(event.message);
    observer?.(event);
  }, message => errors.push(message));
}

async function close() {
  if (!host) return;
  host.close(); host = undefined;
  let timeout;
  try { await Promise.race([closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Scale QA app did not close")), 6000); })]); }
  finally { clearTimeout(timeout); }
}

function uniform(event) {
  assert(Math.abs(event.contentWidth / event.logicalWidth - event.effectiveScale) < 0.001, "Horizontal content scale drifted");
  assert(Math.abs(event.contentHeight / event.logicalHeight - event.effectiveScale) < 0.001, "Vertical content scale drifted");
}

try {
  await cp(join(root, "packages/companions/native/CodexBridge Companions.app"), bundle, { recursive: true });
  await exec("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${identifier}`, join(bundle, "Contents/Info.plist")]);
  await exec("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, bundle]);
  await launch(1);
  await wait("empty startup", event => event.type === "window" && event.count === 0 && !event.visible && !event.rendering);
  await wait("empty resize stays asleep", event => event.type === "window" && event.scale === 0.75 && !event.visible && !event.rendering,
    () => host.send({ type: "set-scale", scale: 0.75 }));
  const initial = await wait("missing rig preserves mixed fallback", event => event.type === "window" && event.count === 1 && event.visible,
    () => {
      host.send({ type: "state", characterId: "scale-smoke", state: "working",
        appearance: { column: 1, headColumn: 2, bodyColumn: 1, label: "SCALE", rig: "missing-rig" } });
      host.send({ type: "window-status" });
    });
  for (const scale of [0.5, 0.75, 1, 1.5, 2]) {
    const event = await wait(`scale ${scale}`, event => event.type === "window" && event.scale === scale,
      () => host.send({ type: "set-scale", scale }));
    uniform(event);
    assert.equal(event.x, initial.x, "Scale changed the horizontal anchor");
    assert.equal(event.y, initial.y, "Scale changed the vertical anchor");
    assert.equal(event.visible, true);
  }
  const caption = "Проверка пропорционального размера лица, тела и длинной реплики. ".repeat(24);
  host.send({ type: "caption", characterId: "scale-smoke", text: caption });
  const capture = join(temporary, "caption.png");
  const snapshot = await wait("all caption characters remain available", event => event.type === "snapshot" && event.path === capture,
    () => host.send({ type: "snapshot", path: capture, background: "dark" }));
  assert.equal(snapshot.bubble.laidOutCharacters, caption.length);
  assert.equal(snapshot.bubble.scrollable, true);
  host.send({ type: "hide" });
  await wait("hidden resize stays asleep", event => event.type === "window" && event.scale === 0.75 && event.hidden && !event.visible && !event.rendering,
    () => host.send({ type: "set-scale", scale: 0.75 }));
  await close();
  await launch(1.25);
  await wait("explicit size restored after restart", event => event.type === "window" && event.scale === 0.75 && event.count === 0 && !event.rendering);
  await wait("reset returns project size", event => event.type === "window" && event.scale === 1.25 && !event.rendering,
    () => host.send({ type: "reset-scale" }));
  await close();
  await launch(1.5);
  await wait("reset restores configuration precedence", event => event.type === "window" && event.scale === 1.5 && !event.rendering);
  assert.equal(errors.length, 0, errors.join("; "));
  console.log(`PASS ${results.length} real native scale checks; microphone, speech and MLX not started`);
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await close().catch(error => { console.error(error); process.exitCode = 1; });
  await exec("/usr/bin/defaults", ["delete", identifier]).catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
  await mkdir(join(root, ".local"), { recursive: true });
  await writeFile(join(root, ".local/companion-scale-smoke.json"), JSON.stringify({ checkedAt: new Date().toISOString(), passed: !process.exitCode, results, errors }, null, 2) + "\n");
}
