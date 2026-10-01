import { spawn } from "node:child_process";

export type NativeEvent = Record<string, unknown> & { type: string };
export interface NativeHost {
  send(event: object): void;
  close(): void;
}

/** Bounded JSONL channel: a native crash never leaves OpenCode waiting on a dead voice process. */
export async function startNativeHost(binary: string, args: string[], receive: (event: NativeEvent) => void,
  log: (message: string) => void): Promise<NativeHost> {
  const child = spawn(binary, args, { stdio: "pipe" });
  let buffer = "", ready = false, closed = false;
  let resolveReady: () => void, rejectReady: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let forceKill: NodeJS.Timeout | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    child.stdin.end(); child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), 1500); forceKill.unref();
  };
  const fail = (error: Error): void => { log(error.message); rejectReady(error); close(); };
  const timeout = setTimeout(() => fail(new Error("Native voice startup timed out")), 15_000);
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      if (newline > 128_000) { fail(new Error("Native voice output exceeded its frame limit")); return; }
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as NativeEvent;
        if (!event || typeof event.type !== "string") throw new Error("Invalid native voice event");
        if (event.type === "ready" && !ready) { ready = true; clearTimeout(timeout); resolveReady(); }
        receive(event);
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
    }
    if (buffer.length > 128_000) fail(new Error("Native voice output exceeded its frame limit"));
  });
  child.once("error", fail);
  child.stdin.on("error", error => { if (!closed) fail(error); });
  process.once("exit", close);
  child.once("close", code => {
    clearTimeout(timeout); clearTimeout(forceKill); process.removeListener("exit", close);
    if (!ready) rejectReady(new Error(`Native voice exited before startup (${code})`));
    if (!closed && ready) log("Voice companion was closed. Restart OpenCode to reopen it.");
    closed = true;
  });
  await started;
  return {
    send(event) {
      if (closed || child.stdin.destroyed) throw new Error("Voice companion is closed; restart OpenCode");
      if (child.stdin.writableLength > 512_000) throw new Error("Native voice queue is full");
      child.stdin.write(JSON.stringify(event) + "\n");
    },
    close,
  };
}
