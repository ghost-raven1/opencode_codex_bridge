import { createHash } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
  throw new Error("Install snip v0.25.2 manually on this platform: https://github.com/edouard-claude/snip/releases/tag/v0.25.2");
}
const version = "0.25.2";
const filename = `snip_${version}_${process.platform}_${process.arch === "x64" ? "amd64" : "arm64"}.tar.gz`;
const base = `https://github.com/edouard-claude/snip/releases/download/v${version}/`;
const download = async name => {
  const response = await fetch(base + name, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Download failed: ${name} HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
const archive = await download(filename);
const checksums = (await download("checksums.txt")).toString();
const expected = checksums.split("\n").find(line => line.trim().endsWith(filename))?.split(/\s+/)[0];
const actual = createHash("sha256").update(archive).digest("hex");
if (actual !== expected) throw new Error("snip checksum mismatch");
const downloads = join(root, ".local", "downloads"), bin = join(root, ".local", "bin");
await mkdir(downloads, { recursive: true }); await mkdir(bin, { recursive: true });
const saved = join(downloads, filename);
await writeFile(saved, archive);
const unpack = spawnSync("tar", ["-xOf", saved, "snip"], { maxBuffer: 64 * 1024 * 1024 });
if (unpack.status !== 0) throw new Error(unpack.stderr.toString());
await writeFile(join(bin, "snip"), unpack.stdout); await chmod(join(bin, "snip"), 0o755);
console.log(`Installed local snip ${version}; SHA256 ${actual}`);
