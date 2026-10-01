import { spawn, execFile, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, constants, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

/** Only actual bundle executables need LaunchServices to give TCC the app's usage descriptions. */
export function applicationBundle(binary: string): string | undefined {
  const executableDirectory = dirname(binary), contents = dirname(executableDirectory), bundle = dirname(contents);
  return basename(executableDirectory) === "MacOS" && basename(contents) === "Contents" && bundle.endsWith(".app")
    ? bundle : undefined;
}

export interface LaunchServicesProcess {
  child: ChildProcess;
  stdin: Writable;
  stdout: Readable;
  directory: string;
  acceptPID(pid: unknown): boolean;
  kill(signal: NodeJS.Signals): void;
  cleanup(): void;
}
type Launcher = (args: string[]) => ChildProcess;
const launch: Launcher = args => spawn("/usr/bin/open", args, { stdio: ["ignore", "ignore", "pipe"] });

const wouldBlock = (error: unknown): boolean => ["EAGAIN", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Use filesystem descriptors directly: Bun's net.Socket rejects writes to adopted FIFOs. */
function fifoReader(path: string): Readable {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  const bytes = Buffer.allocUnsafe(64 * 1024);
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => { timer ??= setTimeout(poll, 10); };
  const stream = new Readable({
    read: schedule,
    destroy(error, done) { clearTimeout(timer); closeSync(fd); done(error); },
  });
  function poll(): void {
    timer = undefined;
    if (stream.destroyed) return;
    try {
      // Yield after 512 KiB even when a misbehaving child writes continuously.
      for (let frame = 0; frame < 8; frame++) {
        const count = readSync(fd, bytes, 0, bytes.length, null);
        if (!count) { stream.push(null); return; }
        if (!stream.push(Buffer.from(bytes.subarray(0, count)))) return;
      }
      schedule();
    } catch (error) {
      if (wouldBlock(error)) schedule();
      else stream.destroy(error as Error);
    }
  }
  return stream;
}

/** Retry only a full nonblocking pipe; Writable retains byte-counted backpressure for the host. */
function fifoWriter(path: string): Writable {
  const fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
  let timer: NodeJS.Timeout | undefined, pending: ((error?: Error | null) => void) | undefined;
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      let offset = 0;
      pending = done;
      const finish = (error?: Error): void => { const callback = pending; pending = undefined; callback?.(error); };
      const attempt = (): void => {
        timer = undefined;
        if (stream.destroyed) { finish(new Error("Native voice pipe is closed")); return; }
        try {
          while (offset < chunk.length) {
            const count = writeSync(fd, chunk, offset, chunk.length - offset);
            if (!count) { timer = setTimeout(attempt, 10); return; }
            offset += count;
          }
          finish();
        } catch (error) {
          if (wouldBlock(error)) timer = setTimeout(attempt, 10);
          else finish(error as Error);
        }
      };
      attempt();
    },
    destroy(error, done) {
      clearTimeout(timer); closeSync(fd);
      const callback = pending; pending = undefined;
      callback?.(error ?? new Error("Native voice pipe is closed")); done(error);
    },
  });
  return stream;
}

/** Private FIFOs preserve streaming stdio while LaunchServices owns the native app's TCC identity. */
export async function launchApplication(bundle: string, args: string[], start: Launcher = launch): Promise<LaunchServicesProcess> {
  const directory = mkdtempSync(join(tmpdir(), "codexbridge-voice-"));
  chmodSync(directory, 0o700);
  const input = join(directory, "stdin"), output = join(directory, "stdout");
  const bootstrap: number[] = [];
  let stdin: Writable | undefined, stdout: Readable | undefined, pid: number | undefined, cleaned = false;
  const releaseBootstrap = (): void => { for (const fd of bootstrap.splice(0)) closeSync(fd); };
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    // Unlink first: a late LaunchServices open fails instead of waiting for a peer forever.
    rmSync(directory, { recursive: true, force: true });
    releaseBootstrap(); stdin?.destroy(); stdout?.destroy();
  };
  try {
    await promisify(execFile)("/usr/bin/mkfifo", ["-m", "600", input, output]);
    bootstrap.push(openSync(input, constants.O_RDWR | constants.O_NONBLOCK));
    bootstrap.push(openSync(output, constants.O_RDWR | constants.O_NONBLOCK));
    stdin = fifoWriter(input);
    stdout = fifoReader(output);
    // The host attaches reporting listeners immediately after this factory resolves.
    stdin.on("error", () => {}); stdout.on("error", () => {});
    const child = start(["-n", "-W", "-g", "-a", bundle, "--stdin", input, "--stdout", output, "--stderr", "/dev/null",
      "--args", ...args, "--ipc-directory", directory, "--ipc-parent-pid", String(process.pid)]);
    child.stderr?.resume();
    return {
      child, stdin, stdout, directory,
      acceptPID(value) {
        if (pid) return true;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 1 || value === process.pid || value === child.pid) return false;
        pid = value;
        // A process event proves the child has opened both FIFO ends; only its writer now owns stdout.
        releaseBootstrap();
        return true;
      },
      kill(signal) {
        cleanup();
        if (pid) {
          try { process.kill(pid, signal); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        // Keep open -W as the app-exit monitor until the app terminates or escalation is required.
        if (!pid || signal === "SIGKILL") child.kill(signal);
      },
      cleanup,
    };
  } catch (error) { cleanup(); throw error; }
}
