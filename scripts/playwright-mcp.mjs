import { access, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { playwrightDirectories } from "./lib/mcp-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories = playwrightDirectories(root, process.cwd());
// Set before importing Playwright, which resolves the browser cache at module load time.
process.env.PLAYWRIGHT_BROWSERS_PATH = directories.browsers;
const require = createRequire(import.meta.url);
const mcpPackage = require.resolve("@playwright/mcp/package.json");
const playwright = createRequire(mcpPackage)("playwright-core");
const executable = playwright.chromium.executablePath();
try { await access(executable); }
catch { console.error("Playwright Chromium is missing. Run npm run setup:playwright in CodexBridge."); process.exit(1); }
await mkdir(directories.artifacts, { recursive: true });
const cli = join(dirname(mcpPackage), "cli.js");
process.argv = [process.execPath, cli, "--isolated", "--headless", "--executable-path", executable,
  "--output-dir", directories.artifacts, "--timeout-navigation", "30000"];
await import(pathToFileURL(cli).href);
