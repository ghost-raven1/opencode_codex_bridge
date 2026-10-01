import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { beginCodexLogin } from "../packages/bridge/src/auth-login.js";

class FakeLoginConnection extends EventEmitter {
  initialize = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  call = vi.fn(async (_method: string, _params: unknown) => ({ type: "chatgpt", authUrl: "https://auth.openai.com/authorize", loginId: "login-1" }));
  finish(success = true, loginId = "login-1") {
    this.emit("message", { method: "account/login/completed", params: { loginId, success } });
  }
}

describe("official Codex browser login bridge", () => {
  it.each(["auth.openai.com", "chatgpt.com"])("accepts %s and returns only a non-secret marker", async host => {
    const connection = new FakeLoginConnection();
    connection.call.mockResolvedValue({ type: "chatgpt", authUrl: `https://${host}/authorize`, loginId: "login-1" });
    const clearAccountCache = vi.fn();
    const login = await beginCodexLogin(connection, clearAccountCache);
    expect(connection.call).toHaveBeenCalledWith("account/login/start", { type: "chatgpt" });
    expect(login.method).toBe("auto");
    if (login.method !== "auto") throw new Error("Expected automatic callback");
    const result = login.callback();
    connection.finish();
    expect(await result).toEqual({ type: "success", key: "codexbridge-managed" });
    expect(clearAccountCache).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("ignores another login id and captures completion before the start reply", async () => {
    const connection = new FakeLoginConnection();
    connection.call.mockImplementation(async () => {
      connection.finish(false, "someone-else");
      connection.finish();
      return { type: "chatgpt", authUrl: "https://auth.openai.com/authorize", loginId: "login-1" };
    });
    const login = await beginCodexLogin(connection, vi.fn());
    if (login.method !== "auto") throw new Error("Expected automatic callback");
    expect(await login.callback()).toEqual({ type: "success", key: "codexbridge-managed" });
  });

  it("closes a denied login without switching the cached account", async () => {
    const connection = new FakeLoginConnection();
    const clearAccountCache = vi.fn();
    const login = await beginCodexLogin(connection, clearAccountCache);
    if (login.method !== "auto") throw new Error("Expected automatic callback");
    const result = login.callback();
    connection.finish(false);
    await expect(result).rejects.toThrow("not completed");
    expect(clearAccountCache).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("rejects a non-OpenAI login URL", async () => {
    const connection = new FakeLoginConnection();
    connection.call.mockResolvedValue({ type: "chatgpt", authUrl: "https://example.com/authorize", loginId: "login-1" });
    await expect(beginCodexLogin(connection, vi.fn())).rejects.toThrow("Unexpected Codex login host");
    expect(connection.close).toHaveBeenCalled();
  });
});
