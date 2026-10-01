import { CodexConnection } from "../packages/bridge/dist/connection.js";

// No model inference and no account secrets in the output.
const connection = new CodexConnection();
try {
  await connection.initialize();
  const result = await connection.call("model/list", { limit: 1 });
  if (!Array.isArray(result.data)) throw new Error("Unexpected model/list response");
  console.log("PASS: real Codex app-server initialize + model/list over stdio (no inference)");
} finally { await connection.close(); }
