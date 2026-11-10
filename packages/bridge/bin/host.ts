/**
 * What the launcher commands (`start`, `install-mod`, `doctor`) read the machine through: the environment, the
 * platform, the repository they run from and the programs they run. {@link denoLauncherHost} is this process; tests
 * pass a fake.
 */

import { fromFileUrl } from "@std/path";
import type { Env } from "../src/config.ts";
import { hostPlatform, type Platform } from "../src/platform.ts";
import { resolveAllowedCommand } from "../src/policy/spawn.ts";

/** The repository root (this file is `<repo>/packages/bridge/bin/host.ts`), without a trailing slash. */
export const REPO = fromFileUrl(new URL("../../..", import.meta.url)).replace(/\/$/, "");

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface LauncherHost {
  env: Env;
  /** The host platform; a `ConfigError` where unsupported. */
  platform(): Platform;
  /** The repository root: the bridge runs with it as its working directory. */
  repo: string;
  /** `Deno.build.arch`. */
  arch: string;
  /** The absolute path `--allow-run=deno` resolved (the `deno` the bridge runs), else `deno`. */
  denoPath(): string;
  /** Runs a program to completion (stdin closed); throws when it cannot start. */
  exec(command: string, args: string[], cwd?: string): Promise<ExecResult>;
  /** The kernel release (`Deno.osRelease()`), or null when this process may not ask. */
  osRelease(): string | null;
  /**
   * Runs the bridge (`deno <args>` in `cwd`) in the foreground with this process's stdio and environment; resolves to
   * its exit code.
   */
  runBridge(args: string[], cwd: string): Promise<number>;
}

const decoder = new TextDecoder();

export const denoLauncherHost: LauncherHost = {
  env: Deno.env,
  platform: hostPlatform,
  repo: REPO,
  arch: Deno.build.arch,
  denoPath: () => resolveAllowedCommand("deno"),
  async exec(command, args, cwd) {
    const r = await new Deno.Command(command, { args, cwd, stdin: "null", stdout: "piped", stderr: "piped" }).output();
    return { code: r.code, stdout: decoder.decode(r.stdout), stderr: decoder.decode(r.stderr) };
  },
  osRelease() {
    if (Deno.permissions.querySync({ name: "sys", kind: "osRelease" }).state !== "granted") return null;
    return Deno.osRelease();
  },
  async runBridge(args, cwd) {
    const child = new Deno.Command("deno", { args, cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
      .spawn();
    // launchd and `kill` signal the launcher alone: pass SIGTERM on. A terminal's Ctrl-C already reaches the bridge
    // (same process group), so SIGINT is passed on only without one; the launcher itself waits for the bridge's exit.
    const forward = (signal: Deno.Signal) => () => {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    };
    const listeners: [Deno.Signal, () => void][] = [
      ["SIGTERM", forward("SIGTERM")],
      ["SIGINT", Deno.stdin.isTerminal() ? () => {} : forward("SIGINT")],
    ];
    for (const [signal, listener] of listeners) Deno.addSignalListener(signal, listener);
    try {
      return (await child.status).code;
    } finally {
      for (const [signal, listener] of listeners) Deno.removeSignalListener(signal, listener);
    }
  },
};
