/**
 * Runs one allowed program for a mod: no stdin, stdout/stderr captured up to 4 MiB each (the rest is drained and
 * dropped), killed with SIGKILL at the deadline (DESIGN-v2 §2.3). Programs are spawned by the names the bridge's
 * `--allow-run` lists (`git`, `hc`, `herdr-app`, `deno`, `cockpit`), so Deno's own run permission is a second check.
 */

import { join } from "@std/path";
import type { ExecResult } from "./decision.ts";

/** Output kept per stream. */
export const OUTPUT_CAP_BYTES = 4 * 1024 * 1024;
/** Longest any exec may run (a mod's own `timeout` can only shorten it). */
export const EXEC_MAX_TIMEOUT_MS = 60_000;
/** Herdr's default `exec` timeout. */
export const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
/** Exit code reported when the deadline killed the program (as `timeout(1)` does). */
export const TIMED_OUT_EXIT_CODE = 124;

export interface SpawnSpec {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Start from an empty environment (mod hosts and scoped runners); otherwise `env` is added to the bridge's. */
  clearEnv?: boolean;
  timeoutMs: number;
}

/** The deadline for a mod-requested exec: the mod's `timeout` (ms, default 30 s), at most `cap`. */
export function execTimeout(requested: unknown, cap = EXEC_MAX_TIMEOUT_MS): number {
  const ms = typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? requested
    : EXEC_DEFAULT_TIMEOUT_MS;
  return Math.min(ms, cap);
}

/**
 * The absolute path Deno resolved for an `--allow-run` name at startup (e.g. `deno` → `/opt/homebrew/bin/deno`),
 * found by asking the permission system about each `PATH` candidate, so no file under those directories is read.
 * Needed when a child gets its own `PATH`: Deno then resolves the program name with the child's `PATH` (measured:
 * `deno` with `PATH=/bin` → "Failed to spawn 'deno': entity not found"). Falls back to the bare name.
 */
export function resolveAllowedCommand(name: string, path = Deno.env.get("PATH") ?? ""): string {
  if (name.includes("/")) return name;
  for (const dir of path.split(":")) {
    if (!dir.startsWith("/")) continue;
    const candidate = join(dir, name);
    if (Deno.permissions.querySync({ name: "run", command: candidate }).state !== "granted") continue;
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch (e) {
      // Not readable by the bridge: granted means it is exactly the path Deno resolved for the name.
      if (e instanceof Deno.errors.NotCapable) return candidate;
    }
  }
  return name;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  for await (const chunk of stream) {
    if (kept >= OUTPUT_CAP_BYTES) continue;
    const part = chunk.length > OUTPUT_CAP_BYTES - kept ? chunk.subarray(0, OUTPUT_CAP_BYTES - kept) : chunk;
    chunks.push(part);
    kept += part.length;
  }
  const out = new Uint8Array(kept);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Spawns and waits. Throws when the program cannot start (Herdr rejects in that case); resolves otherwise, with
 * `TIMED_OUT_EXIT_CODE` and a note on stderr when the deadline killed it.
 */
export async function runCapped(spec: SpawnSpec): Promise<ExecResult> {
  const child = new Deno.Command(spec.command, {
    args: [...spec.args],
    cwd: spec.cwd,
    env: spec.env,
    clearEnv: spec.clearEnv ?? false,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, spec.timeoutMs);
  try {
    const [stdout, stderr, status] = await Promise.all([collect(child.stdout), collect(child.stderr), child.status]);
    const dec = new TextDecoder();
    const result = { code: status.code, stdout: dec.decode(stdout), stderr: dec.decode(stderr) };
    if (!timedOut) return result;
    return {
      code: TIMED_OUT_EXIT_CODE,
      stdout: result.stdout,
      stderr: `${result.stderr}${result.stderr && !result.stderr.endsWith("\n") ? "\n" : ""}herdr-relay: ${
        spec.command.slice(spec.command.lastIndexOf("/") + 1)
      } timed out after ${spec.timeoutMs} ms`,
    };
  } finally {
    clearTimeout(timer);
  }
}
