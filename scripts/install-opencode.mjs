import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installOpenCode } from "./lib/opencode-install.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const configDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
const installed = await installOpenCode(root, configDir);
console.log(`Bridge installed: ${installed.entry}\nProvider configured: ${installed.configFile}\nRun: opencode /path/to/project`);
