import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(root, ".local/lsp-smoke-"));
const path = join(directory, "example.ts");
const source = "const result: number = 'wrong type';\n";
await writeFile(path, source);
const child = spawn(process.execPath, [join(root, "node_modules/typescript-language-server/lib/cli.mjs"), "--stdio"], { stdio: "pipe" });
let errors = "";
child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-3000); });
const exit = new Promise(resolve => child.once("exit", resolve));
const send = value => {
  const body = JSON.stringify(value);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
let buffer = Buffer.alloc(0);
try {
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`LSP diagnostics timeout: ${errors}`)), 20_000);
    child.once("error", reject);
    child.stdout.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const size = Number(buffer.subarray(0, end).toString().match(/Content-Length: (\d+)/i)?.[1]);
        if (!Number.isFinite(size) || buffer.length < end + 4 + size) return;
        const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
        buffer = buffer.subarray(end + 4 + size);
        if (process.env.LSP_SMOKE_DEBUG) console.log({ method: message.method, id: message.id, error: message.error,
          diagnostics: message.params?.diagnostics, message: message.params?.message });
        if (message.method && message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: null });
        if (message.id === 1) {
          if (message.error) { clearTimeout(deadline); reject(new Error(message.error.message)); return; }
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {
            textDocument: { uri: pathToFileURL(path).href, languageId: "typescript", version: 1, text: source },
          } });
        }
        if (message.method === "textDocument/publishDiagnostics" && message.params.diagnostics.some(d => d.code === 2322)) {
          clearTimeout(deadline); resolve();
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      processId: process.pid, rootUri: pathToFileURL(directory).href,
      capabilities: { textDocument: { publishDiagnostics: {} } },
      initializationOptions: { tsserver: { path: join(root, "node_modules/typescript/lib/tsserver.js") } },
    } });
  });
  console.log("PASS: real TypeScript LSP returned TS2322 for an invalid assignment");
} finally {
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), 1500); await exit; clearTimeout(kill);
}
