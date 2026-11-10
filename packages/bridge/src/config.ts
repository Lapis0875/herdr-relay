/**
 * Bridge configuration (DESIGN-v2 §1.2, §1.4), read from the environment at run time. `HERDR_APP_HOME`,
 * `HERDR_RELAY_PORT` and `HERDR_RELAY_DEV` are never interpolated by `deno task` (its shell has no
 * `${VAR:-default}`); the bridge resolves them here through `Deno.env` (all in its `--allow-env`). What differs per
 * operating system (`TMPDIR` default, sandbox provider, Tailscale CLI, …) comes from `platform.ts`.
 */

import type { Platform } from "./platform.ts";

/** Path prefix the bridge is published under (`tailscale serve --set-path`) and that loopback URLs carry. */
export const MOUNT = "/herdr-relay";

/** `HERDR_RELAY_PORT` when unset. */
export const DEFAULT_PORT = 7781;

/** `PATH` for policy-run programs when the bridge has none. */
export const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * `HERDR_RELAY_DEV`: unset/empty = `off`; `1` = `dev` (`deno task start:dev`; adds the Android emulator's
 * `10.0.2.2` loopback alias); `insecure-no-sandbox` = run mod hosts without the platform's sandbox, which also disables
 * pairing and every tailnet request so the unconfined mode can never face the tailnet. Any other value is a
 * configuration error.
 */
export type DevMode = "off" | "dev" | "insecure-no-sandbox";

export interface BridgeConfig {
  home: string;
  /** `HERDR_APP_HOME`, else `$HOME/.config/herdr-app` (lexical; callers realpath it). */
  appHome: string;
  /** `<state>` = `$HOME/.herdr/herdr-relay`: token, devices.json, vapid.json, push.json, storage/, log/. */
  stateDir: string;
  /** Parent of `<run>` = `$TMPDIR/herdr-relay`; each bridge run uses `<runRoot>/<run-id>/`. */
  runRoot: string;
  port: number;
  dev: DevMode;
  /** `false` in `insecure-no-sandbox`: pairing codes are refused and so is every tailnet request. */
  pairing: boolean;
  /** The repository root (lexical): bridge-authored scripts live under it. */
  repo: string;
  /** `packages/web`: the app shell (`index.html`, `manifest.webmanifest`, `sw.js`, `dist/`, `public/`). */
  webRoot: string;
  /** `packages/modhost`: the mod host every supervised `deno run` loads. */
  modhost: string;
  /** `PATH` (default `/usr/bin:/bin:/usr/sbin:/sbin`) and `TMPDIR` for programs run with a cleared environment. */
  programEnv: { PATH: string; TMPDIR: string };
  /** The operating system the bridge runs on (`hostPlatform()`, or a fake in tests). */
  platform: Platform;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The subset of `Deno.env` the loaders use (tests pass a plain map). */
export interface Env {
  get(name: string): string | undefined;
}

/** `<state>` for a home directory. */
export function stateDirOf(home: string): string {
  return `${trimSlash(home)}/.herdr/herdr-relay`;
}

export function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(value)) throw new ConfigError(`HERDR_RELAY_PORT must be a port number, got "${value}"`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new ConfigError(`HERDR_RELAY_PORT must be 1–65535, got ${port}`);
  return port;
}

export function parseDevMode(value: string | undefined): DevMode {
  if (value === undefined || value === "") return "off";
  if (value === "1") return "dev";
  if (value === "insecure-no-sandbox") return "insecure-no-sandbox";
  throw new ConfigError(`HERDR_RELAY_DEV must be unset, "1" or "insecure-no-sandbox", got "${value}"`);
}

/** `HOME` (required, absolute). */
export function homeFrom(env: Env): string {
  const home = env.get("HOME");
  if (!home || !home.startsWith("/")) throw new ConfigError("HOME must be set to an absolute path");
  return trimSlash(home);
}

/**
 * The configuration on `platform`. A platform without a mod-host sandbox (Linux until T39) is a configuration error
 * unless `HERDR_RELAY_DEV=insecure-no-sandbox`, which keeps the bridge off the tailnet.
 */
export function loadConfig(platform: Platform, env: Env = Deno.env): BridgeConfig {
  const home = homeFrom(env);
  const appHomeEnv = env.get("HERDR_APP_HOME");
  if (appHomeEnv && !appHomeEnv.startsWith("/")) throw new ConfigError("HERDR_APP_HOME must be an absolute path");
  const tmpEnv = env.get("TMPDIR") || platform.tmpDir;
  if (!tmpEnv.startsWith("/")) throw new ConfigError("TMPDIR must be an absolute path");
  const tmp = trimSlash(tmpEnv);
  const dev = parseDevMode(env.get("HERDR_RELAY_DEV"));
  if (platform.sandbox === null && dev !== "insecure-no-sandbox") {
    throw new ConfigError(
      `no mod-host sandbox for ${platform.label} yet, so mod hosts cannot be confined; refusing to start. For local ` +
        "development only, HERDR_RELAY_DEV=insecure-no-sandbox runs without it (pairing and tailnet access off).",
    );
  }
  const repo = trimSlash(decodeURIComponent(new URL("../../..", import.meta.url).pathname));
  return {
    home,
    appHome: appHomeEnv ? trimSlash(appHomeEnv) : `${home}/.config/herdr-app`,
    stateDir: stateDirOf(home),
    runRoot: `${tmp}/herdr-relay`,
    port: parsePort(env.get("HERDR_RELAY_PORT")),
    dev,
    pairing: dev !== "insecure-no-sandbox",
    repo,
    webRoot: `${repo}/packages/web`,
    modhost: `${repo}/packages/modhost`,
    programEnv: { PATH: env.get("PATH") || DEFAULT_PATH, TMPDIR: tmp },
    platform,
  };
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}
