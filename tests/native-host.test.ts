import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { once } from "node:events";
import { startNativeHost, type NativeEvent } from "../packages/companions/src/native-host.js";
import { applicationBundle, launchApplication } from "../packages/companions/src/launch-services.js";

const launch = (script: string, receive = (_event: NativeEvent) => {}) =>
  startNativeHost(process.execPath, ["-e", script], receive, () => {});

describe("native voice transport", () => {
  it("waits for a native handshake and handles split UTF-8 transcripts", async () => {
    let received: (text: unknown) => void;
    const text = new Promise(resolve => { received = resolve; });
    const host = await launch(`
      process.stdout.write('{"type":"ready"}\\n');
      process.stdin.once('data', () => {
        const frame = Buffer.from(JSON.stringify({type:'transcript',text:'Привет'})+'\\n');
        const split = frame.indexOf(Buffer.from('Привет')) + 1;
        process.stdout.write(frame.subarray(0,split));
        setTimeout(()=>process.stdout.write(frame.subarray(split)),10);
      });
    `, event => { if (event.type === "transcript") received(event.text); });
    try { host.send({ type: "test" }); expect(await text).toBe("Привет"); }
    finally { host.close(); }
  });
  it("rejects a process that exits before ready", async () => {
    await expect(launch("process.exit(2)")).rejects.toThrow("before startup");
  });
  it("rejects startup immediately when stdout closes but the process remains alive", async () => {
    await expect(launch(`
      require('node:fs').closeSync(1);
      setTimeout(() => process.exit(0), 1000);
    `)).rejects.toThrow("Native voice output closed before startup");
  });
  it("disconnects and reaps a ready process when its output channel reaches EOF", async () => {
    const events: NativeEvent[] = [];
    const host = await launch(`
      process.stdout.write(JSON.stringify({type:'ready',pid:process.pid})+'\\n');
      process.stdin.once('data', () => require('node:fs').closeSync(1));
      setInterval(() => {}, 1000);
    `, event => events.push(event));
    try {
      host.send({ type: "close-output" });
      await vi.waitFor(() => expect(events.filter(event => event.type === "closed")).toHaveLength(1), { timeout: 500 });
      expect(() => host.send({ type: "show" })).toThrow("closed");
      const pid = events.find(event => event.type === "ready")!.pid as number;
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { host.close(); }
  });
  it("rejects malformed or unbounded native output", async () => {
    await expect(launch("process.stdout.write('garbage\\n');setInterval(()=>{},1000)")).rejects.toThrow();
    await expect(launch("process.stdout.write('x'.repeat(150000));setInterval(()=>{},1000)")).rejects.toThrow("frame limit");
  });
  it("accepts adjacent large frames without applying the limit to their combined buffer", async () => {
    let complete: () => void;
    const delivered = new Promise<void>(resolve => { complete = resolve; });
    let count = 0;
    const host = await launch(`
      process.stdout.write('{"type":"ready"}\\n');
      process.stdin.once('data', () => process.stdout.write(
        (JSON.stringify({type:'large',text:'x'.repeat(100000)})+'\\n').repeat(3)
      ));
    `, event => { if (event.type === "large" && ++count === 3) complete(); });
    try { host.send({ type: "test" }); await delivered; expect(count).toBe(3); }
    finally { host.close(); }
  });
  it("fails sends after explicit shutdown instead of silently dropping them", async () => {
    const host = await launch("process.stdout.write('{\"type\":\"ready\"}\\n');process.stdin.resume()");
    host.close(); host.close();
    expect(() => host.send({ type: "speak" })).toThrow("closed");
  });
  it("notifies the caller once after the voice process closes", async () => {
    let complete: () => void;
    const closed = new Promise<void>(resolve => { complete = resolve; });
    const events: NativeEvent[] = [];
    const host = await launch("process.stdout.write('{\"type\":\"ready\"}\\n');process.stdin.resume()", event => {
      events.push(event); if (event.type === "closed") complete();
    });
    host.close(); host.close(); await closed;
    expect(events.filter(event => event.type === "closed")).toHaveLength(1);
  });
  it("drops buffered events after the receiver closes the host", async () => {
    const events: NativeEvent[] = [];
    let complete!: () => void;
    const closed = new Promise<void>(resolve => { complete = resolve; });
    const host = await launch(`
      process.stdout.write('{"type":"ready"}\\n');
      process.stdin.once('data', () => process.stdout.write(
        '{"type":"disconnect"}\\n{"type":"transcript","text":"late text"}\\n'
      ));
      setInterval(() => {}, 1000);
    `, event => {
      events.push(event);
      if (event.type === "disconnect") host.close();
      if (event.type === "closed") complete();
    });
    try {
      host.send({ type: "test" }); await closed;
      expect(events.map(event => event.type)).toEqual(["ready", "disconnect", "closed"]);
    } finally { host.close(); }
  });
  it("limits incoming and outgoing frames by UTF-8 bytes", async () => {
    await expect(launch("process.stdout.write(JSON.stringify({type:'large',text:'я'.repeat(70000)})+'\\n');setInterval(()=>{},1000)"))
      .rejects.toThrow("frame limit");
    const host = await launch("process.stdout.write('{\"type\":\"ready\"}\\n');process.stdin.resume()");
    try { expect(() => host.send({ type: "speak", text: "я".repeat(70000) })).toThrow("frame limit"); }
    finally { host.close(); }
  });
  it("reaps a process that ignores graceful shutdown", async () => {
    let pid: number | undefined;
    const host = await launch(`
      process.on('SIGTERM',()=>{});
      process.stdout.write(JSON.stringify({type:'ready',pid:process.pid})+'\\n');
      setInterval(()=>{},1000);
    `, event => { if (event.type === "ready") pid = event.pid as number; });
    host.close();
    await vi.waitFor(() => {
      expect(pid).toBeTypeOf("number");
      let alive = true; try { process.kill(pid!, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    }, { timeout: 3000, interval: 50 });
  });
  it("times out before ready and still terminates the launched process", async () => {
    let pid: number | undefined, identify: () => void;
    const identified = new Promise<void>(resolve => { identify = resolve; });
    vi.useFakeTimers();
    try {
      const started = launch(`
        process.stdout.write(JSON.stringify({type:'process',pid:process.pid})+'\\n');
        setInterval(()=>{},1000);
      `, event => { if (event.type === "process") { pid = event.pid as number; identify(); } });
      const rejected = expect(started).rejects.toThrow(/startup timed out \(process \d+ started; waiting for ready; (?:Bun|Node) /);
      await identified;
      await vi.advanceTimersByTimeAsync(15_000); await rejected;
      await vi.advanceTimersByTimeAsync(1500);
      vi.useRealTimers();
      await vi.waitFor(() => {
        let alive = true; try { process.kill(pid!, 0); } catch { alive = false; }
        expect(alive).toBe(false);
      });
    } finally {
      vi.useRealTimers();
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } }
    }
  });
  it("identifies a timeout before the native process handshake", async () => {
    let complete: () => void;
    const closed = new Promise<void>(resolve => { complete = resolve; });
    vi.useFakeTimers();
    try {
      const started = launch("setInterval(()=>{},1000)", event => { if (event.type === "closed") complete(); });
      const rejected = expect(started).rejects.toThrow("startup timed out (no process handshake received;");
      await vi.advanceTimersByTimeAsync(15_000); await rejected;
      vi.useRealTimers(); await closed;
    } finally { vi.useRealTimers(); }
  });
});

// The fake launcher is a distinct monitor process, matching open -W rather than spawning the app directly.
const fakeLauncher = (script: string) => (args: string[]) => spawn(process.execPath, ["-e", `
  const fs = require('node:fs'), { spawn } = require('node:child_process');
  const args = process.argv.slice(1), value = name => args[args.indexOf(name) + 1];
  const input = fs.openSync(value('--stdin'), 'r'), output = fs.openSync(value('--stdout'), 'w');
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(script)}, '--', ...args.slice(args.indexOf('--args') + 1)],
    { stdio: [input, output, 'ignore'] });
  fs.closeSync(input); fs.closeSync(output);
  child.on('exit', code => process.exit(code ?? 0));
`, "--", ...args], { stdio: ["ignore", "ignore", "pipe"] });
const fifoApp = `
  const fs = require('node:fs');
  const emit = value => fs.writeSync(1, JSON.stringify(value) + '\\n');
  emit({type:'process',pid:process.pid}); emit({type:'ready',pid:process.pid});
  let pending = ''; const buffer = Buffer.alloc(4096);
  while (true) {
    const count = fs.readSync(0, buffer); if (!count) break;
    pending += buffer.toString('utf8', 0, count);
    let newline;
    while ((newline = pending.indexOf('\\n')) !== -1) {
      const request = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
      emit({type:'reply',text:request.text});
    }
  }
`;

describe("LaunchServices voice transport", () => {
  it("routes only bundle executables through LaunchServices", () => {
    expect(applicationBundle("/Applications/CodexBridge Companions.app/Contents/MacOS/Companions"))
      .toBe("/Applications/CodexBridge Companions.app");
    expect(applicationBundle(process.execPath)).toBeUndefined();
    expect(applicationBundle("/tmp/file.app/Companions")).toBeUndefined();
  });
  it("uses private FIFOs, exchanges frames, and reaps the app after stdin EOF", async () => {
    const transport = await launchApplication("/Applications/Test Voice.app", [], fakeLauncher(fifoApp));
    const events: NativeEvent[] = [];
    let pending = "", ready: () => void, reply: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const answered = new Promise<void>(resolve => { reply = resolve; });
    transport.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString(); let index: number;
      while ((index = pending.indexOf("\n")) !== -1) {
        const event = JSON.parse(pending.slice(0, index)) as NativeEvent; pending = pending.slice(index + 1);
        events.push(event);
        if (event.type === "process") transport.acceptPID(event.pid);
        if (event.type === "ready") ready();
        if (event.type === "reply") reply();
      }
    });
    const exited = once(transport.child, "close");
    try {
      expect(statSync(transport.directory).mode & 0o777).toBe(0o700);
      for (const name of ["stdin", "stdout"]) {
        const stat = statSync(`${transport.directory}/${name}`);
        expect(stat.isFIFO()).toBe(true); expect(stat.mode & 0o777).toBe(0o600);
      }
      await started;
      const text = "x".repeat(100_000) + " Проверка IPC";
      transport.stdin.write(JSON.stringify({ text }) + "\n");
      await answered;
      expect(events.at(-1)).toMatchObject({ type: "reply", text });
      transport.stdin.destroy();
      await exited;
    } finally { transport.kill("SIGKILL"); transport.cleanup(); }
    expect(existsSync(transport.directory)).toBe(false);
  });
  it("unlinks pending FIFO paths on early shutdown and closes the launcher", async () => {
    const transport = await launchApplication("/Applications/Test Voice.app", [],
      () => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "pipe"] }));
    const exited = once(transport.child, "close");
    expect(transport.acceptPID(process.pid)).toBe(false);
    expect(transport.acceptPID(1)).toBe(false);
    expect(transport.acceptPID(transport.child.pid)).toBe(false);
    transport.kill("SIGTERM"); await exited;
    expect(existsSync(transport.directory)).toBe(false);
    expect(transport.stdin.destroyed).toBe(true);
    expect(transport.stdout.destroyed).toBe(true);
  });
});
