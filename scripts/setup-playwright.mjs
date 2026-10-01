import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { playwrightDirectories } from "./lib/mcp-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
const child = spawn(process.execPath, [cli, "install-browser", "chromium"], {
  cwd: root, stdio: "inherit", env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: playwrightDirectories(root, root).browsers },
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
