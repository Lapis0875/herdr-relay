/**
 * The host platform seam (OSS-PLAN §1 G7, G10–G12, G14, §3; DECISIONS O2): what differs between the computers the
 * bridge runs on. macOS is the v1 platform. Linux is described too (openers, deny list, peer check, Tailscale CLI) but
 * has no mod-host sandbox provider until bubblewrap (T39), so `loadConfig` refuses it unless
 * `HERDR_RELAY_DEV=insecure-no-sandbox`. Any other OS (Windows) is a {@link ConfigError}.
 *
 * {@link resolvePlatform} reads the machine through a {@link PlatformHost} (tests pass a fake); {@link hostPlatform} is
 * the bridge's own, resolved once.
 */

import { join } from "@std/path";
import { ConfigError } from "./config.ts";
import type { Sandbox } from "./hosts/sandbox.ts";
import { seatbeltSandbox } from "./hosts/seatbelt.ts";

/** How a mod's request to open something maps to the exec policy (E11 / E12). */
export interface PlatformOpeners {
  /** Programs that open a URL on this computer: `<program> <http(s) url>` is E11, opened on the device instead. */
  device: readonly string[];
  /** Other platforms' openers: E12, refused (they do not exist here). */
  foreign: readonly string[];
}

/**
 * How `auth/peer.ts` finds who owns the caller's side of a loopback connection: `netstat-lsof` (macOS: `netstat`, `ps`
 * and `lsof` spawned) or `proc-net-tcp` (Linux: `/proc/net/tcp{,6}` read, nothing spawned).
 */
export type PeerStrategy = "netstat-lsof" | "proc-net-tcp";

export interface Platform {
  os: "darwin" | "linux";
  /** Its name in device-visible refusals and log lines. */
  label: string;
  openers: PlatformOpeners;
  /** The Tailscale CLI to run (G7, {@link resolveTailscaleBin}). */
  tailscaleBin: string;
  /**
   * The bridge's `--deny-read` entries relative to `$HOME` (G10): credentials and browser data where this OS keeps
   * them. `$HOME` stays the outer read bound.
   */
  denyReadUnderHome: readonly string[];
  peerCheck: PeerStrategy;
  /** The mod-host kernel sandbox; `null` where this version has none (only `insecure-no-sandbox` starts there). */
  sandbox: Sandbox | null;
  /** A program that exits 0 (the sandbox availability probe runs it). */
  trueBin: string;
  /** `TMPDIR` when unset. */
  tmpDir: string;
}

/** What resolving the platform reads from the machine. */
export interface PlatformHost {
  /** `Deno.build.os`. */
  os: string;
  /** An environment variable; `undefined` when unset or outside this process's `--allow-env`. */
  env(name: string): string | undefined;
  /** Whether `path` is a file; `null` when this process may not look (outside its `--allow-read`). */
  isFile(path: string): boolean | null;
  /** Whether this process's `--allow-run` covers exactly `path`. */
  mayRun(path: string): boolean;
}

/** This process, through permission queries first, so resolving never prompts and never fails on a missing grant. */
export const denoHost: PlatformHost = {
  os: Deno.build.os,
  env: (name) =>
    Deno.permissions.querySync({ name: "env", variable: name }).state === "granted" ? Deno.env.get(name) : undefined,
  isFile(path) {
    if (Deno.permissions.querySync({ name: "read", path }).state !== "granted") return null;
    try {
      return Deno.statSync(path).isFile;
    } catch (e) {
      return e instanceof Deno.errors.NotFound || e instanceof Deno.errors.NotADirectory ? false : null;
    }
  },
  mayRun: (path) => Deno.permissions.querySync({ name: "run", command: path }).state === "granted",
};

/** Overrides the Tailscale CLI (absolute path); read only when the bridge's `--allow-env` lists it. */
export const TAILSCALE_BIN_ENV = "HERDR_RELAY_TAILSCALE_BIN";

/**
 * The macOS app's own binary, which is also its CLI when run with `TAILSCALE_BE_CLI=1` (`~/.local/bin/tailscale` is a
 * `#!/bin/sh` wrapper that sets it; without it the binary starts the app).
 */
export const TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/**
 * The Tailscale CLI (G7): `HERDR_RELAY_TAILSCALE_BIN`, else on macOS the app bundle in `/Applications`, then in
 * `~/Applications`, else `tailscale` on `PATH` (Linux, the Homebrew formula), else the bare name. A candidate counts
 * when it is a file, or, where this process may not look, when its `--allow-run` names exactly that path: the
 * launcher resolves with read access and grants only the path it found, so the bridge arrives at the same one.
 */
export function resolveTailscaleBin(os: Platform["os"], host: PlatformHost): string {
  const set = host.env(TAILSCALE_BIN_ENV);
  if (set) {
    if (!set.startsWith("/")) throw new ConfigError(`${TAILSCALE_BIN_ENV} must be an absolute path, got "${set}"`);
    return set;
  }
  const home = host.env("HOME");
  const bundles = os === "darwin"
    ? [TAILSCALE_APP_CLI, ...(home?.startsWith("/") ? [join(home, TAILSCALE_APP_CLI)] : [])]
    : [];
  const onPath = (host.env("PATH") ?? "").split(":").filter((dir) => dir.startsWith("/")).map((dir) =>
    join(dir, "tailscale")
  );
  return [...bundles, ...onPath].find((path) => host.isFile(path) ?? host.mayRun(path)) ?? "tailscale";
}

/** Credentials every Unix home may hold. */
const HOME_SECRETS = [".ssh", ".gnupg", ".aws", ".config/gh"];
const DARWIN_TRUE = "/usr/bin/true";

const DARWIN: Omit<Platform, "tailscaleBin"> = {
  os: "darwin",
  label: "macOS",
  openers: {
    device: ["open"],
    foreign: ["xdg-open", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "start"],
  },
  denyReadUnderHome: [...HOME_SECRETS, "Library/Keychains", "Library/Cookies"],
  peerCheck: "netstat-lsof",
  sandbox: seatbeltSandbox(DARWIN_TRUE),
  trueBin: DARWIN_TRUE,
  tmpDir: "/tmp",
};

const LINUX: Omit<Platform, "tailscaleBin"> = {
  os: "linux",
  label: "Linux",
  openers: {
    device: ["xdg-open"],
    foreign: ["open", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "start"],
  },
  denyReadUnderHome: [
    ...HOME_SECRETS,
    ".local/share/keyrings",
    ".mozilla",
    ".config/google-chrome",
    ".password-store",
    ".docker/config.json",
  ],
  peerCheck: "proc-net-tcp",
  sandbox: null,
  trueBin: "/bin/true",
  tmpDir: "/tmp",
};

/** The platform `host` runs; a {@link ConfigError} on any OS but macOS and Linux. */
export function resolvePlatform(host: PlatformHost): Platform {
  const base = host.os === "darwin" ? DARWIN : host.os === "linux" ? LINUX : null;
  if (base === null) throw new ConfigError(`${host.os === "windows" ? "Windows" : host.os} is not supported yet`);
  return { ...base, tailscaleBin: resolveTailscaleBin(base.os, host) };
}

let resolved: Platform | undefined;

/** The platform the bridge runs on (resolved on first use; a {@link ConfigError} where unsupported). */
export function hostPlatform(): Platform {
  return resolved ??= resolvePlatform(denoHost);
}
