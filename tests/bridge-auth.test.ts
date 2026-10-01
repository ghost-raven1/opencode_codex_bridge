import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexFetch } from "../packages/bridge/src/auth-provider.js";
import { createSessionReader, type CodexSession } from "../packages/bridge/src/auth-session.js";

const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const identity = (accessToken = "test-access"): CodexSession => ({ accessToken, accountId: "test-account", expiresAt: Date.now() + 3600_000 });
const request = (body: Record<string, unknown> = {}) => ({ method: "POST", headers: { authorization: "Bearer marker" }, body: JSON.stringify({ model: "test-model", input: [], stream: true, ...body }) });
afterEach(() => vi.useRealTimers());

describe("Codex authentication memory cache", () => {
  it("shares one initial RPC and refreshes only when expiry requires it", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => identity());
    const read = createSessionReader(load);
    await Promise.all([read(), read()]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenLastCalledWith(false);
    await read();
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    await read();
    expect(load).toHaveBeenLastCalledWith(false);
    await read(true);
    expect(load).toHaveBeenLastCalledWith(true);
  });

  it("waits for a normal lookup before coalescing a forced refresh", async () => {
    let release!: (session: CodexSession) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise<CodexSession>(resolve => { release = resolve; }))
      .mockResolvedValueOnce(identity("refreshed"));
    const read = createSessionReader(load);
    const initial = read();
    const forced = read(true);
    const anotherForced = read(true);
    release(identity("old"));
    expect((await initial).accessToken).toBe("old");
    expect((await forced).accessToken).toBe("refreshed");
    expect((await anotherForced).accessToken).toBe("refreshed");
    expect(load.mock.calls).toEqual([[false], [true]]);
  });

  it("picks up account switch after the short TTL and refuses expired credentials", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValueOnce(identity("first")).mockResolvedValueOnce(identity("second"));
    const read = createSessionReader(load);
    expect((await read()).accessToken).toBe("first");
    vi.advanceTimersByTime(61_000);
    expect((await read()).accessToken).toBe("second");
    const expired = createSessionReader(async () => ({ ...identity(), expiresAt: 0 }));
    await expect(expired()).rejects.toThrow("expired access credentials");
  });
});

describe("Codex Responses transport", () => {
  it("authenticates only the fixed official endpoint and preserves OpenCode tool schemas", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const fetchCodex = createCodexFetch(async () => identity(), transport);
    const tools = [{ type: "function", name: "read", parameters: { type: "object" } }];
    await fetchCodex(endpoint, request({ tools, store: true, max_output_tokens: 999, temperature: 1 }));
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-access");
    expect(headers.get("ChatGPT-Account-Id")).toBe("test-account");
    expect(headers.get("originator")).toBe("codexbridge");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ store: false, stream: true, instructions: "", tools });
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("temperature");
  });

  it("does not send credentials or even query Codex auth for an arbitrary host", async () => {
    const read = vi.fn(async () => identity());
    const transport = vi.fn<typeof fetch>();
    const fetchCodex = createCodexFetch(read, transport);
    await expect(fetchCodex("https://example.com/responses", request())).rejects.toThrow("official Codex");
    await expect(fetchCodex(endpoint, { method: "GET" })).rejects.toThrow("POST");
    expect(read).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("refreshes once on 401, without replaying other errors", async () => {
    const read = vi.fn(async refresh => identity(refresh ? "new" : "old"));
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("expired", { status: 401 })).mockResolvedValueOnce(new Response("ok"));
    await createCodexFetch(read, transport)(endpoint, request());
    expect(read.mock.calls).toEqual([[false], [true]]);
    expect(new Headers(transport.mock.calls[1]![1]?.headers).get("authorization")).toBe("Bearer new");
    const badRequest = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad", { status: 400 }));
    expect((await createCodexFetch(read, badRequest)(endpoint, request())).status).toBe(400);
    expect(badRequest).toHaveBeenCalledTimes(1);
  });

  it("converts chunked CRLF SSE into a final JSON response for SDK doGenerate", async () => {
    const parts = ["event: response.created\r", "\ndata: {\"type\":\"response.created\"}\r", "\n\r", "\nevent: response.completed\r\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"output\":[]}}\r", "\n\r", "\n"];
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    const response = await createCodexFetch(async () => identity(), transport)(endpoint, request({ stream: false }));
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ id: "r1", output: [] });
  });

  it("fails a prematurely closed response and honors cancellation before authentication", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("data: {\"type\":\"response.created\"}\n\n"));
    await expect(createCodexFetch(async () => identity(), transport)(endpoint, request({ stream: false }))).rejects.toThrow("before its final response");
    const read = vi.fn(async () => identity());
    const controller = new AbortController(); controller.abort();
    await expect(createCodexFetch(read, transport)(endpoint, { ...request(), signal: controller.signal })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
});
