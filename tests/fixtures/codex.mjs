import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let cwd, mode, pending;
function finish(text, status = "completed") {
  send({ method: "item/completed", params: { threadId: "thread-1", item: { id: "message-1", type: "agentMessage", text } } });
  send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status, error: status === "failed" ? { message: "provider unavailable" } : null } } });
}
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  const { id, method, params } = request;
  if (method === "initialize") send({ id, result: { userAgent: "fixture" } });
  else if (method === "thread/read") send({ id, result: { thread: { id: params.threadId, cwd: process.cwd() } } });
  else if (method === "thread/start" || method === "thread/resume") {
    cwd = params.cwd;
    if (params.sandbox !== "workspace-write" || params.approvalPolicy !== "on-request") throw new Error("Unsafe permissions");
    send({ id, result: { thread: { id: "thread-1", cwd } } });
  } else if (method === "turn/start") {
    mode = params.input[0].text;
    send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    if (mode === "crash") process.exit(2);
    if (mode === "malformed") { process.stdout.write("invalid json\n"); return; }
    if (mode === "overflow") { process.stdout.write("x".repeat(8 * 1024 * 1024 + 1)); return; }
    if (mode === "hang") {
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", itemId: "message-1", delta: "running" } });
      send({ id, result: { turn: { id: "turn-1" } } }); return;
    }
    if (mode.startsWith("approval")) {
      pending = id;
      const method = mode === "approval-permissions" ? "item/permissions/requestApproval" : "item/commandExecution/requestApproval";
      send({ id: "approval-1", method, params: { threadId: "thread-1", command: "touch /tmp/requested", cwd,
        permissions: { network: { enabled: true } } } });
      return;
    }
    if (mode === "split") {
      const encoded = Buffer.from(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-1", itemId: "message-1", delta: "こんにちは, Лёха" } }) + "\n");
      const point = encoded.indexOf(Buffer.from("Л")) + 1;
      process.stdout.write(encoded.subarray(0, point));
      process.stdout.write(encoded.subarray(point));
    }
    if (mode === "public-messages") {
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", itemId: "progress", delta: "Draft fragment" } });
      for (const item of [
        { id: "reasoning", type: "reasoning", text: "Private reasoning" },
        { id: "command", type: "commandExecution", text: "Raw tool output" },
        { id: "analysis", type: "agentMessage", phase: "analysis", text: "Non-public phase" },
        { id: "progress", type: "agentMessage", phase: "commentary", text: "Проверяю изменения." },
        { id: "progress", type: "agentMessage", phase: "commentary", text: "Проверяю изменения." },
      ]) send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item } });
      send({ method: "item/completed", params: { threadId: "thread-1", turnId: "old-turn", item: { id: "old", type: "agentMessage", text: "Stale turn" } } });
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", itemId: "unfinished", delta: "Unfinished text" } });
    }
    if (mode === "completed-overflow") for (let n = 0; n < 2; n++) {
      send({ method: "item/completed", params: { threadId: "thread-1", item: { id: `large-${n}`, type: "agentMessage", text: "x".repeat(2_200_000) } } });
    }
    finish(mode === "split" ? "こんにちは, Лёха" : "done", mode === "failed" ? "failed" : "completed");
    // Deliberately complete before the turn/start response to exercise notification ordering.
    send({ id, result: { turn: { id: "turn-1" } } });
  } else if (id === "approval-1") {
    finish(JSON.stringify(request.result));
    send({ id: pending, result: { turn: { id: "turn-1" } } });
  } else if (method === "turn/interrupt") {
    send({ id, result: {} }); finish("cancelled", "interrupted");
  }
});
