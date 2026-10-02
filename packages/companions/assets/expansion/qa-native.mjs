import assert from "node:assert/strict";
import { cp, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startNativeHost } from "../../dist/native-host.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const exec = promisify(execFile);
const availableRoles = ["lead", "code", "research", "review", "designer", "devops", "tester"];
const roles = process.argv.slice(2).length ? process.argv.slice(2) : availableRoles;
assert(roles.every(role => availableRoles.includes(role)), "Pass known rig IDs as positional arguments");
const output = join(root, ".local/companions-snapshots", roles.length === availableRoles.length ? "work-rig-joints" : "work-rig-joints-followup");
const phases = [.25, .375, .5, .625, .75];
const referenceNow = () => Date.now() / 1000 - 978307200;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const all = [];

/** Match the native WorkAnimation clock so captures cover both gesture styles deterministically. */
function schedule(id) {
  let seed = 14695981039346656037n;
  for (const byte of Buffer.from(id)) seed = BigInt.asUintN(64, (seed ^ BigInt(byte)) * 1099511628211n);
  const period = 8.2 + Number(seed % 31n) / 10;
  const shift = Number(seed % 997n) / 97;
  const cycle = Math.ceil((referenceNow() + 2 + shift) / period);
  return { period, shift, cycle, parity: Number(seed % 2n) };
}

for (const scale of [.5, 2]) {
  const temporary = await mkdtemp(join(tmpdir(), "codexbridge-work-art-"));
  const bundle = join(temporary, "Work Art QA.app");
  const identifier = `dev.codexbridge.workart.${Date.now()}`;
  let host, pending, pid, closed = false, cleaned = false;
  const errors = [];
  let resolveClosed;
  const didClose = new Promise(resolve => { resolveClosed = resolve; });
  try {
    await cp(join(root, "packages/companions/native/CodexBridge Companions.app"), bundle, { recursive: true });
    await exec("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${identifier}`, join(bundle, "Contents/Info.plist")]);
    await exec("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, bundle]);
    host = await startNativeHost(join(bundle, "Contents/MacOS/Companions"), ["--atlas", join(bundle, "Contents/Resources/team-atlas.png"),
      "--config", JSON.stringify({ enabled: true, speech: "off", dictation: false, maxVisible: 4, scale })], event => {
      if (event.type === "ready") pid = event.pid;
      if (event.type === "closed") { closed = true; resolveClosed(); }
      if (event.type === "error") errors.push(event.message);
      pending?.(event);
    }, message => { if (!cleaned) errors.push(message); });
    for (const [column, role] of roles.entries()) {
      const id = `work-qa-${role}`;
      host.send({ type: "state", characterId: id, state: "working", appearance: {
        rig: role, column: column % 4, headColumn: column % 4, bodyColumn: column % 4, label: role.toUpperCase() } });
      await delay(1300);
      const clock = schedule(id);
      for (const variation of [0, 1]) for (const phase of phases) for (const background of ["light", "dark"]) {
        const target = (clock.cycle + variation) * clock.period - clock.shift + phase * 4.2;
        const name = `${role}-style-${(clock.cycle + variation + clock.parity) % 2}-phase-${phase}-${background}.png`;
        const directory = join(output, `scale-${scale}`);
        const capture = join(temporary, name);
        await mkdir(directory, { recursive: true });
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { pending = undefined; reject(new Error(`Snapshot timeout ${name}`)); }, 4000);
          pending = event => {
            if (event.type === "snapshot" && event.path === capture) { clearTimeout(timeout); pending = undefined; resolve(); }
            if (event.type === "error") { clearTimeout(timeout); pending = undefined; reject(new Error(event.message)); }
          };
          host.send({ type: "snapshot", path: capture, background, offset: target - referenceNow() });
        });
        await copyFile(capture, join(directory, name));
        all.push({ role, scale, phase, style: (clock.cycle + variation + clock.parity) % 2, background, path: join(directory, name), targetTime: target });
      }
      host.send({ type: "remove", characterId: id });
      await delay(500);
    }
    assert.equal(errors.length, 0, errors.join("; "));
  } finally {
    cleaned = true;
    host?.close();
    if (host && !closed) await Promise.race([didClose, delay(5000).then(() => { throw new Error("QA app did not close"); })]);
    if (pid) {
      await delay(100);
      try { process.kill(pid, 0); throw new Error(`QA process ${pid} remains alive`); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await exec("/usr/bin/defaults", ["delete", identifier]).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}
await writeFile(join(output, "report.json"), JSON.stringify({ checkedAt: new Date().toISOString(), snapshots: all, passed: true }, null, 2) + "\n");
console.log(`PASS ${all.length} native phase snapshots, ${roles.join(", ")}, both styles, scales 0.5/2, light/dark; QA processes reaped.`);
