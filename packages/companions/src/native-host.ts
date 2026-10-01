import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { applicationBundle, launchApplication } from "./launch-services.js";

export type NativeEvent = Record<string, unknown> & { type: string };
export interface NativeHost {
  send(event: object): void;
  close(): void;
}
const MAX_FRAME = 128_000;
const MAX_QUEUE = 512_000;

/** Bounded JSONL channel with LaunchServices for macOS bundles and ordinary stdio for CLI fixtures. */
export async function startNativeHost(binary: string, args: string[], receive: (event: NativeEvent) => void,
  log: (message: string) => void): Promise<NativeHost> {
  const bundle = process.platform === "darwin" ? applicationBundle(binary) : undefined;
  const launched = bundle ? await launchApplication(bundle, args) : undefined;
  const child = launched?.child ?? spawn(binary, args, { stdio: "pipe" });
  const stdin = launched?.stdin ?? child.stdin!, stdout = launched?.stdout ?? child.stdout!;
  const decoder = new StringDecoder("utf8");
  let buffer = "", ready = false, closed = false, nativePID: number | undefined;
  let resolveReady: () => void, rejectReady: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let forceKill: NodeJS.Timeout | undefined;
  const signal = (name: NodeJS.Signals): void => {
    if (launched) launched.kill(name);
    else child.kill(name);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    if (!launched) stdin.destroy();
    signal("SIGTERM");
    forceKill = setTimeout(() => signal("SIGKILL"), 1500); forceKill.unref();
  };
  const fail = (error: Error): void => {
    if (closed) return;
    log(error.message); rejectReady(error); close();
  };
  const timeout = setTimeout(() => {
    const phase = nativePID ? `process ${nativePID} started; waiting for ready` : "no process handshake received";
    const runtime = process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`;
    fail(new Error(`Native voice startup timed out (${phase}; ${runtime})`));
  }, 15_000);
  child.stderr?.resume();
  stdout.on("data", (chunk: Buffer) => {
    if (closed) return;
    buffer += decoder.write(chunk);
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME) { fail(new Error("Native voice output exceeded its frame limit")); return; }
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as NativeEvent;
        if (!event || Array.isArray(event) || typeof event.type !== "string") throw new Error("Invalid native voice event");
        if (event.type === "process") {
          if (typeof event.pid === "number" && Number.isSafeInteger(event.pid) && event.pid > 1) nativePID = event.pid;
          launched?.acceptPID(event.pid);
        }
        if (event.type === "ready" && launched && !launched.acceptPID(event.pid)) throw new Error("Native voice ready event is missing its process identity");
        if (event.type === "ready" && !ready) { ready = true; clearTimeout(timeout); resolveReady(); }
        receive(event);
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME) fail(new Error("Native voice output exceeded its frame limit"));
  });
  stdout.on("error", fail);
  child.once("error", fail);
  stdin.on("error", error => { if (!closed) fail(error); });
  process.once("exit", close);
  child.once("close", code => {
    clearTimeout(timeout); clearTimeout(forceKill); process.removeListener("exit", close);
    if (!ready) rejectReady(new Error(`Native voice exited before startup (${code})`));
    if (!closed && ready) log("Voice companion was closed. Restart OpenCode to reopen it.");
    closed = true; launched?.cleanup();
    try { receive({ type: "closed" }); }
    catch (error) { log(error instanceof Error ? error.message : String(error)); }
  });
  await started;
  if (closed) throw new Error("Native voice closed during startup");
  return {
    send(event) {
      if (closed || stdin.destroyed) throw new Error("Voice companion is closed; restart OpenCode");
      const frame = JSON.stringify(event) + "\n";
      const bytes = Buffer.byteLength(frame);
      if (bytes > MAX_FRAME) throw new Error("Native voice input exceeded its frame limit");
      if (stdin.writableLength + bytes > MAX_QUEUE) throw new Error("Native voice queue is full");
      stdin.write(frame);
    },
    close,
  };
}
