/**
 * The byte pipe under one core connection. Production uses an `hc connect` child (its stdio carries the core API,
 * DESIGN-v2 §1.1); tests plug in an in-process pair of streams (T21's fake core).
 */

import { CoreError, messageOf } from "./errors.ts";

export interface CoreTransport {
  /** Bytes from the core. Ends when the peer is gone. */
  readonly readable: ReadableStream<Uint8Array>;
  /** Bytes to the core. */
  readonly writable: WritableStream<Uint8Array>;
  /** Stops the peer (kills the `hc connect` child). Idempotent; never throws. */
  close(): void;
  /** Settles (never rejects) once the peer is fully gone, with a human-readable reason. */
  readonly closed: Promise<string>;
  /** The child's pid, for a process transport. */
  readonly pid?: number;
}

/** Opens one transport; called again for every reconnect. */
export type CoreTransportFactory = () => CoreTransport | Promise<CoreTransport>;

export interface HcConnectOptions {
  /** Executable, spawned by name so the bridge's `--allow-run=hc` matches (DESIGN-v2 §1.2). Default `hc`. */
  command?: string;
  /** Extra variables for the child, added to {@link hcConnectEnv}'s `HOME`/`PATH`; nothing else is passed. */
  env?: Record<string, string>;
  /** Grace after SIGTERM before SIGKILL, ms. Default 2000. */
  killAfterMs?: number;
}

/** The only bridge variables an `hc connect` child gets: hc finds the core under `HOME`, Deno resolves `hc` on `PATH`. */
export const HC_CONNECT_ENV_KEYS = ["HOME", "PATH"] as const;

/**
 * The complete environment of an `hc connect` child (spawned with `clearEnv`): the bridge's `HOME` and `PATH` when
 * set. Nothing else is inherited — in particular no `HC_*` (`HC_TERMINAL_SOCKET`, `HC_TERMINAL_ID`, …): a bridge
 * started inside a Herdr terminal must not hand the child that terminal's identity (Shepherdr strips them too).
 * Reading needs `--allow-env` for both keys; without it this throws Deno's `NotCapable`.
 */
export function hcConnectEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HC_CONNECT_ENV_KEYS) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

const STDERR_TAIL_BYTES = 4096;

/** Spawns `hc connect` with piped stdio. Throws `CoreError("unavailable")` when it cannot start. */
export function spawnHcConnect(options: HcConnectOptions = {}): CoreTransport {
  const command = options.command ?? "hc";
  const killAfterMs = options.killAfterMs ?? 2000;
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(command, {
      args: ["connect"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: hcConnectEnv(options.env),
    }).spawn();
  } catch (error) {
    throw new CoreError("unavailable", `cannot start \`${command} connect\`: ${messageOf(error)}`, { cause: error });
  }
  let exited = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stderr = stderrTail(child.stderr);
  const closed = Promise.all([child.status, stderr]).then(([status, tail]) => {
    exited = true;
    clearTimeout(killTimer);
    const how = status.signal ? `signal ${status.signal}` : `code ${status.code}`;
    return `\`${command} connect\` exited (${how})${tail ? `: ${tail}` : ""}`;
  });
  return {
    readable: child.stdout,
    writable: child.stdin,
    pid: child.pid,
    closed,
    close() {
      if (exited || killTimer !== undefined) return;
      try {
        child.kill("SIGTERM");
      } catch {
        return; // already exited
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { /* exited meanwhile */ }
      }, killAfterMs);
    },
  };
}

/** Reads a child's stderr to its end, keeping the last few KiB as trimmed text. */
async function stderrTail(stream: ReadableStream<Uint8Array>): Promise<string> {
  let tail = new Uint8Array(0);
  try {
    for await (const chunk of stream) {
      const keep = Math.min(tail.length, Math.max(0, STDERR_TAIL_BYTES - chunk.length));
      const next = new Uint8Array(keep + Math.min(chunk.length, STDERR_TAIL_BYTES));
      next.set(tail.subarray(tail.length - keep));
      next.set(chunk.subarray(chunk.length - (next.length - keep)), keep);
      tail = next;
    }
  } catch { /* the pipe broke with the child; keep what arrived */ }
  return new TextDecoder().decode(tail).trim();
}
