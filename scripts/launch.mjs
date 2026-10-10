import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = process.argv[2] ?? "quiet";
if (!["jarvis", "quiet"].includes(profile)) throw new Error("Profile: jarvis | quiet");
const project = resolve(process.argv[3] ?? root);
const configDir = join(root, ".local", "profiles", profile);
await access(join(configDir, "opencode.json"));
// macOS can stall before TUI startup when the runtime initializes inside Documents.
// Pass the actual project explicitly; only the initial process directory is temporary.
const child = spawn("opencode", [project, ...process.argv.slice(4)], {
  cwd: process.platform === "darwin" ? tmpdir() : project, stdio: "inherit", env: {
    ...process.env, OPENCODE_CONFIG: join(configDir, "opencode.json"), OPENCODE_CONFIG_DIR: configDir,
    PATH: [join(root, ".local", "bin"), join(root, "node_modules", ".bin"), process.env.PATH].join(delimiter),
  },
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
