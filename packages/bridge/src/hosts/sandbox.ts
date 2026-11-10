/**
 * Mod-host sandbox providers (OSS-PLAN §1 G12, §3): the kernel layer under each host's Deno permissions. v1 has one
 * provider, Seatbelt (`seatbelt.ts`, macOS); bubblewrap (Linux) is T39. The platform names its provider
 * (`../platform.ts`); where it has none, hosts can only run unconfined, which the bridge allows only in
 * `HERDR_RELAY_DEV=insecure-no-sandbox` (`../config.ts`).
 */

/** One host to confine. Every path is a real path. */
export interface HostLaunch {
  /** The mod folder's name (names the host's files under `<run>/<subdir>`). */
  name: string;
  /** `<appHome>/mods/<name>`: readable, and the host's working directory. */
  folder: string;
  /** `<repo>/packages/modhost`: readable. */
  modhost: string;
  /** `<run>/deno-dir/<name>`: the host's `DENO_DIR`, readable and writable. */
  denoDir: string;
  /** The bridge's control port on 127.0.0.1: the host's only connection. */
  ctlPort: number;
  /** The arguments after `deno` (`run … <modhost>/src/main.js <ctlPort> <name>`). */
  denoArgs: readonly string[];
}

/** A program and its arguments. */
export interface SandboxCommand {
  command: string;
  args: string[];
}

/** A provider prepared for one bridge run. */
export interface SandboxRun {
  /** The subdirectory of `<run>` holding its per-host files; the supervisor removes it when it stops. */
  readonly subdir: string;
  /** The command that starts one host confined; writes that host's files under `<run>/<subdir>` first. */
  command(launch: HostLaunch): Promise<SandboxCommand>;
}

export interface Sandbox {
  /** Provider id (`seatbelt`). */
  readonly id: string;
  /** Its name in log lines (`Seatbelt`). */
  readonly label: string;
  /** Why mod hosts cannot be confined when {@link available} is false (the bridge's refusal starts with it). */
  readonly unavailable: string;
  /** Whether it works on this machine; the bridge refuses to start without it (unless `insecure-no-sandbox`). */
  available(): Promise<boolean>;
  /** Measures what its rules need, once per bridge run; `run` is `<run>` as the bridge itself uses it. */
  prepare(run: string): Promise<SandboxRun>;
}
