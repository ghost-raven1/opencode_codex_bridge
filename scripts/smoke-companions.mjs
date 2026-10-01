import assert from "node:assert/strict";
import { cp, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startNativeHost } from "../packages/companions/dist/native-host.js";

if (process.platform !== "darwin") throw new Error("Companion lifecycle smoke requires macOS");
const root = fileURLToPath(new URL("../", import.meta.url));
const visual = process.argv.includes("--visual");
const reduced = process.argv.includes("--reduce-motion");
const scale = Number(process.argv.find(argument => argument.startsWith("--scale="))?.slice(8) ?? 1);
assert([0.5, 1, 2].includes(scale), "Scale must be 0.5, 1 or 2");
const captureGroup = `scale-${scale}${reduced ? "-reduced" : ""}`;
const snapshots = [];
const exec = promisify(execFile);
await mkdir(join(root, ".local"), { recursive: true });
const temporary = await mkdtemp(join(root, ".local/companions-smoke-"));
const captures = await mkdtemp(join(tmpdir(), "codexbridge-captures-"));
const bundle = join(temporary, "Companions Smoke.app");
const identifier = `dev.codexbridge.companions.smoke.${Date.now()}`;
const results = [], errors = [];
let host, pending, closed = false, nativePID;
let resolveClosed;
const didClose = new Promise(resolve => { resolveClosed = resolve; });

/** Ignore unsolicited geometry events until the requested lifecycle state is observed. */
function windowState(name, matches) {
  return new Promise((resolve, reject) => {
    let last;
    const poll = setInterval(() => {
      try { host.send({ type: "window-status" }); }
      catch { clearInterval(poll); clearTimeout(timer); pending = undefined; reject(new Error(`${name}: native app closed`)); }
    }, 100);
    const timer = setTimeout(() => {
      clearInterval(poll); pending = undefined;
      reject(new Error(`${name}: unexpected window state ${JSON.stringify(last)}`));
    }, 4000);
    pending = event => {
      if (event.type === "closed" || event.type === "error") {
        clearInterval(poll); clearTimeout(timer); pending = undefined; reject(new Error(`${name}: native app failed`)); return;
      }
      if (event.type !== "window") return;
      last = event;
      if (!matches(event)) return;
      clearInterval(poll); clearTimeout(timer); pending = undefined;
      results.push({ name, ...event });
      console.log(`PASS ${name}: ${JSON.stringify({ count: event.count, characters: event.characters,
        hidden: event.hidden, visible: event.visible, rendering: event.rendering, demo: event.demo })}`);
      resolve(event);
    };
    host.send({ type: "window-status" });
  });
}
const realCharacter = { type: "state", characterId: "smoke-real-agent", state: "thinking", role: "developer",
  appearance: { column: 1, headColumn: 1, bodyColumn: 1, label: "CODE" } };
const containsReal = event => event.count === 1 && event.characters?.[0] === realCharacter.characterId;

async function snapshot(name, background, offset = 0, caption) {
  const directory = join(root, ".local/companions-snapshots", captureGroup);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}-${background}.png`);
  // The host owns project files. A native app must not request Documents access just for QA.
  const capture = join(captures, `${name}-${background}.png`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending = undefined; reject(new Error(`Snapshot ${name} timed out`)); }, 4000);
    pending = event => {
      if (event.type === "error") { clearTimeout(timer); pending = undefined; reject(new Error(event.message)); return; }
      if (event.type !== "snapshot" || event.path !== capture) return;
      if (caption !== undefined) {
        try {
          assert.equal(event.bubble?.characters, caption.length, "Caption was truncated");
          assert.equal(event.bubble?.laidOutCharacters, caption.length, "Some caption glyphs were never laid out");
          assert(event.bubble.visibleHeight <= 168, "Caption grew outside the window");
          if (caption.length > 1000) assert.equal(event.bubble.scrollable, true, "Long caption cannot scroll");
        } catch (error) { clearTimeout(timer); pending = undefined; reject(error); return; }
      }
      clearTimeout(timer); pending = undefined; resolve();
    };
    host.send({ type: "snapshot", path: capture, background, offset, ...(caption !== undefined ? { caption } : {}) });
  });
  await copyFile(capture, path);
  assert((await stat(path)).size > 100, `Missing snapshot ${path}`);
  snapshots.push({ name, background, scale, path });
}

async function captureVisuals() {
  const labels = ["LEAD", "CODE", "RESEARCH", "REVIEW"];
  const entries = labels.map((label, column) => ({ type: "state", characterId: `visual-${column}`,
    state: "idle", appearance: { column, headColumn: column, bodyColumn: column, label } }));
  entries.forEach(entry => host.send(entry));
  for (const background of ["light", "dark"]) await snapshot("entrance", background, 0.15);
  await new Promise(resolve => setTimeout(resolve, 1250));
  const longCaption = "Рабочее дерево чистое. Проверю последний коммит с авторизацией и связанный код моста; замечания дам с привязкой к строкам.\n\n".repeat(14);
  for (const background of ["light", "dark"]) await snapshot("long-caption", background, 0, longCaption);
  for (const state of ["idle", "thinking", "working", "waiting", "success", "error"]) {
    entries.forEach(entry => host.send({ ...entry, state }));
    for (const background of ["light", "dark"]) await snapshot(state, background);
  }
  entries.forEach((entry, column) => host.send({ ...entry,
    appearance: { ...entry.appearance, headColumn: (column + 1) % 4 } }));
  for (const background of ["light", "dark"]) await snapshot("transform", background, 0.2);
  await new Promise(resolve => setTimeout(resolve, 1450));
  for (const background of ["light", "dark"]) await snapshot("mixed", background);
  entries.forEach(entry => host.send({ type: "remove", characterId: entry.characterId }));
  for (const background of ["light", "dark"]) await snapshot("leave", background, 0.15);
  await new Promise(resolve => setTimeout(resolve, 450));
  await windowState("visual cleanup stops rendering", event => event.count === 0 && !event.rendering);
  console.log(`PASS visual artifacts: ${snapshots.length} PNGs at scale ${scale}`);
}

try {
  // A separate bundle identity keeps QA hide/show actions out of the user's saved preferences.
  await cp(join(root, "packages/companions/native/CodexBridge Companions.app"), bundle, { recursive: true });
  await exec("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${identifier}`, join(bundle, "Contents/Info.plist")]);
  await exec("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, bundle]);
  host = await startNativeHost(join(bundle, "Contents/MacOS/Companions"), ["--atlas", join(bundle, "Contents/Resources/team-atlas.png"),
    ...(reduced ? ["--reduce-motion"] : []),
    "--config", JSON.stringify({ enabled: true, showOnStart: true, speech: "off", dictation: false, maxVisible: 4, scale })], event => {
    if (event.type === "ready") nativePID = event.pid;
    if (event.type === "closed") { closed = true; resolveClosed(); }
    if (event.type === "error") errors.push(event.message ?? "Native error");
    pending?.(event);
  }, message => errors.push(message));
  await windowState("normal startup ignores legacy showOnStart", event => event.count === 0 &&
    event.characters?.length === 0 && event.visible === false && event.rendering === false);
  host.send(realCharacter);
  await windowState("state creates a real character", event => containsReal(event) && event.visible && event.rendering);
  host.send({ type: "hide" });
  await windowState("hide stops rendering", event => containsReal(event) && event.hidden && !event.visible && !event.rendering);
  host.send({ ...realCharacter, state: "working" });
  await windowState("task state does not undo hide", event => containsReal(event) && event.hidden && !event.rendering);
  host.send({ type: "show" });
  await windowState("show resumes the real character", event => containsReal(event) && !event.hidden && event.visible && event.rendering);
  await snapshot("single-long-caption", "dark", 0,
    "Рабочее дерево чистое. Проверю последний коммит с авторизацией и связанный код моста; замечания дам с привязкой к строкам. ".repeat(10));
  host.send({ type: "preview" });
  await windowState("explicit preview displays the demo", event => event.demo === true && event.count === 4 &&
    event.characters?.every(id => id.startsWith("preview-")) && event.rendering);
  host.send({ type: "show" });
  await windowState("preview preserves the real session", event => event.demo === false && containsReal(event) && event.rendering);
  for (const column of [0, 2, 3]) host.send({ ...realCharacter,
    appearance: { column, headColumn: column, bodyColumn: column, label: "REVIEW" } });
  await new Promise(resolve => setTimeout(resolve, 1450));
  await windowState("rapid role changes keep the latest role", event => containsReal(event) && event.columns?.[0] === 3);
  host.send({ type: "remove", characterId: realCharacter.characterId });
  await new Promise(resolve => setTimeout(resolve, 50));
  host.send(realCharacter);
  await new Promise(resolve => setTimeout(resolve, 1250));
  await windowState("new activity cancels departure", event => containsReal(event) && event.columns?.[0] === 1 && event.visible);
  if (reduced) await windowState("reduce motion uses the reduced renderer", event => event.reducedMotion === true);
  host.send({ type: "remove", characterId: realCharacter.characterId });
  await new Promise(resolve => setTimeout(resolve, 450));
  await windowState("last removal stops rendering", event => event.count === 0 && event.characters?.length === 0 &&
    event.visible === false && event.rendering === false);
  if (visual) await captureVisuals();
  assert.equal(errors.length, 0, errors.join("; "));
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  host?.close();
  if (host && !closed) {
    let timer;
    try {
      await Promise.race([didClose, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("QA app did not exit")), 5000); })]);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { clearTimeout(timer); }
  }
  if (nativePID) {
    const deadline = Date.now() + 2000;
    let reaped = false;
    while (Date.now() < deadline) {
      try { process.kill(nativePID, 0); }
      catch (error) { if (error.code === "ESRCH") reaped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!reaped) { console.error("Could not verify QA process cleanup"); process.exitCode = 1; }
  }
  await exec("/usr/bin/defaults", ["delete", identifier]).catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
  await rm(captures, { recursive: true, force: true });
  await writeFile(join(root, ".local/companions-smoke.json"), JSON.stringify({ checkedAt: new Date().toISOString(),
    passed: !process.exitCode, results, errors, snapshots }, null, 2) + "\n");
  if (visual) await writeFile(join(root, ".local/companions-snapshots", captureGroup, "report.json"),
    JSON.stringify({ passed: !process.exitCode, snapshots }, null, 2) + "\n");
}
