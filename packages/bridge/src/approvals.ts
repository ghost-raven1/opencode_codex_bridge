import type { Approval, JsonObject, RpcMessage } from "./types.js";
import type { CodexConnection } from "./connection.js";

/** A missing host approval channel always declines; model text never counts as approval. */
export async function answerRequest(
  connection: CodexConnection,
  message: RpcMessage,
  approve?: (request: Approval) => Promise<boolean>,
): Promise<void> {
  if (message.id === undefined) return;
  const method = message.method ?? "";
  const details = message.params ?? {};
  const decisions = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"];
  if (!decisions.includes(method) && method !== "item/permissions/requestApproval") {
    connection.reject(message.id, `Unsupported interactive request: ${method}`);
    return;
  }
  let accepted = false;
  try { accepted = (await approve?.({ method, details })) === true; } catch { /* Host denied. */ }
  const result: JsonObject = method === "item/permissions/requestApproval"
    ? { permissions: accepted ? details.permissions ?? {} : {}, scope: "turn" }
    : { decision: accepted ? "accept" : "decline" };
  connection.respond(message.id, result);
}
