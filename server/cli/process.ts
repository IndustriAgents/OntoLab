import { spawn } from "node:child_process";
import { delimiter, isAbsolute } from "node:path";
import { ProviderError } from "../providerErrors.ts";

const active = new Set<number>();
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    /* exited */
  }
}
process.once("exit", () => {
  for (const pid of active) signalGroup(pid, "SIGKILL");
});

export interface CliProcessOptions {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  signal: AbortSignal;
  onEvent: (event: Record<string, unknown>) => void;
  maxBytes?: number;
}

/** No shell, bounded JSONL output, and cancellation of the entire process group. */
export function runCliProcess(opts: CliProcessOptions): Promise<{ code: number | null; stderr: string }> {
  opts.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(opts.binary, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    if (child.pid) active.add(child.pid);
    let buffer = "",
      stderr = "",
      bytes = 0;
    let failure: unknown;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (child.pid) signalGroup(child.pid, "SIGTERM");
      killTimer ??= setTimeout(() => {
        if (child.pid) signalGroup(child.pid, "SIGKILL");
      }, 1000).unref();
    };
    const abort = () => {
      failure ??= opts.signal.reason;
      kill();
    };
    const line = (text: string) => {
      if (failure || !text.trim()) return;
      try {
        const event: unknown = JSON.parse(text);
        if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid event");
        opts.onEvent(event as Record<string, unknown>);
      } catch {
        failure = new ProviderError("The CLI returned an invalid or unsupported event stream. Update the CLI and retry.", 502, false);
        kill();
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      bytes += Buffer.byteLength(text);
      if (bytes > (opts.maxBytes ?? 16 * 1024 * 1024)) {
        failure ??= new ProviderError("The CLI response exceeded the output size limit. Use smaller chunks.", 502, false);
        kill();
        return;
      }
      buffer += text;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
    child.stderr.on("data", (text: string) => {
      stderr = (stderr + text).slice(-16_384);
    });
    child.stdin.on("error", () => {
      /* a CLI may fail before reading stdin; its exit is authoritative */
    });
    child.on("error", () => {
      failure ??= new ProviderError("Could not start the configured CLI executable.", 503, false);
    });
    child.on("close", (code) => {
      if (buffer) line(buffer);
      if (killTimer) clearTimeout(killTimer);
      // Ensure a spawned helper cannot survive a completed or cancelled request.
      if (child.pid) {
        signalGroup(child.pid, "SIGKILL");
        active.delete(child.pid);
      }
      opts.signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ code, stderr });
    });
    opts.signal.addEventListener("abort", abort, { once: true });
    if (opts.signal.aborted) abort();
    child.stdin.end(opts.input);
  });
}

/** Credentials for storage and API providers never enter a CLI child environment. */
export function cliEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "CODEX_HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "SystemRoot",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.CI = "1";
  env.PATH =
    (env.PATH ?? "")
      .split(delimiter)
      .filter((dir) => isAbsolute(dir) && !dir.includes("node_modules"))
      .join(delimiter) || "/usr/bin:/bin";
  env.NO_COLOR = "1";
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  return env;
}
