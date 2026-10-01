import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mcpConfiguration } from "./lib/mcp-config.mjs";
import { mcpExitCode, probeMcpServer, textContent } from "./lib/mcp-probe.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = mcpConfiguration(root);
const strict = process.argv.includes("--strict"), offline = process.argv.includes("--offline");

async function verifyContext7(call) {
  const resolved = textContent(await call("resolve-library-id", {
    libraryName: "Playwright", query: "Create an isolated browser context with Playwright",
  }));
  assert(resolved.includes("/microsoft/playwright"), "Playwright library was not resolved");
  const docs = textContent(await call("query-docs", {
    libraryId: "/microsoft/playwright", query: "How do I create and close an isolated browser context?",
  }));
  assert(/newContext|browser context/i.test(docs), "No relevant browser-context documentation");
  return "resolved /microsoft/playwright and fetched browser-context documentation";
}

async function verifyPlaywright(call) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>CodexBridge MCP smoke</title><h1>Browser check</h1><button onclick="document.querySelector(\'p\').textContent=\'Browser works\'">Check browser</button><p>Waiting</p>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await call("browser_navigate", { url: `http://127.0.0.1:${server.address().port}` });
    const page = textContent(await call("browser_snapshot"));
    const ref = /button "Check browser" \[ref=([^\]]+)\]/.exec(page)?.[1];
    assert(ref, "Browser snapshot did not expose the test button");
    await call("browser_click", { element: "Check browser button", target: ref });
    const snapshot = textContent(await call("browser_snapshot"));
    assert(snapshot.includes("Browser works"), "The browser click did not change the page");
    const screenshot = textContent(await call("browser_take_screenshot", { type: "png", scale: "css" }));
    return `isolated Chromium navigate + click + snapshot + screenshot; ${screenshot.split("\n").find(line => line.includes(".png")) ?? "artifact saved"}`;
  } finally {
    await call("browser_close").catch(() => undefined);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const servers = [
  { name: "bridge", config: { type: "local", command: [process.execPath, join(root, "packages/bridge/dist/mcp.js")] },
    expectedTool: "codex", optional: false },
  { name: "jarvis", config: config.jarvis, expectedTool: "get_voice_input" },
  { name: "playwright", config: config.playwright, expectedTool: "browser_navigate", verify: verifyPlaywright, timeout: 40_000 },
  ...(offline ? [] : [
    { name: "context7", config: config.context7, expectedTool: "resolve-library-id", verify: verifyContext7 },
    { name: "grep", config: config.grep, expectedTool: "searchGitHub", verify: async call => {
      const result = textContent(await call("searchGitHub", { query: "useEffect", repo: "vercel/next.js" }));
      assert(/vercel\/next\.js/i.test(result), "No Next.js source matches returned");
      return "found useEffect source examples in vercel/next.js";
    } },
    { name: "openai_docs", config: config.openai_docs, expectedTool: "search_openai_docs", verify: async call => {
      const result = textContent(await call("search_openai_docs", { query: "Responses API", limit: 2 }));
      assert(/https:\/\//.test(result), "No documentation links returned");
      return "searched Responses API documentation and received source links";
    } },
  ]),
];
const results = [];
for (const server of servers) {
  const result = await probeMcpServer(server);
  results.push(result);
  console.log(`${result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "WARN optional"} ${result.name}: ${result.detail}`);
}
await mkdir(join(root, ".local/mcp"), { recursive: true });
await writeFile(join(root, ".local/mcp/smoke.json"), JSON.stringify({ checkedAt: new Date().toISOString(), strict, offline, results }, null, 2) + "\n");
process.exitCode = mcpExitCode(results, strict);
