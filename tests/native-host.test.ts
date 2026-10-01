import { describe, expect, it } from "vitest";
import { startNativeHost, type NativeEvent } from "../packages/companions/src/native-host.js";

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
});
