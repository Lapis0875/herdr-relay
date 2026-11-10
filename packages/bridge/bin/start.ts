/**
 * `herdr-relay start` (OSS-PLAN §5 "launcher", G7, G18; T44): runs the bridge with its `deno run` flags computed at
 * run time instead of the fixed `deno task start` line. On macOS, with `TMPDIR` set, `HERDR_APP_HOME` and
 * `HERDR_RELAY_TAILSCALE_BIN` unset and the Tailscale app in `/Applications`, the command is byte-identical to that
 * task (both run in the repository root, so `./packages`, `./deno.json`, `deno.lock` and the entry stay relative);
 * only `argv[0]` differs (`deno` from `PATH` here, its real path under `deno task`). `--allow-env` lists
 * `HERDR_RELAY_TAILSCALE_BIN` in both, so the bridge honours the launcher's Tailscale override.
 *
 * What is computed instead of fixed:
 * - `--allow-run`'s Tailscale entry is the CLI the launcher resolves (`platform.ts` G7: the override, the app bundle,
 *   then `PATH`), so the bridge resolves the same one; the sandbox program and the peer-check programs follow the
 *   platform (macOS: `sandbox-exec`, `netstat`/`ps`/`lsof`; Linux: `/proc/net/tcp{,6}` readable, nothing spawned).
 * - `--deny-read` is the platform's list (G10) plus `devices.json.bak` (`policy/scripts.ts`).
 * - G18: `--allow-write` names `<appHome>/data/herdr-relay` of the resolved app home (`HERDR_APP_HOME` when set), and
 *   an app home outside `$HOME` and the temporary roots is added to `--allow-read`.
 * - `TMPDIR` unset: the platform's (`/tmp`), as the bridge itself resolves it, where `deno task` would expand
 *   `$TMPDIR/herdr-relay` to `/herdr-relay`.
 *
 * `--allow-import=jsr.io:443` limits module loading to the locked JSR packages: without it Deno 2.9 grants import
 * from every host and only `--cached-only` stops a remote import (`main.ts --self-test`, `import https://`).
 *
 * Before the bridge starts, `<state>/environment.json` is compared and rewritten (`./environment.ts`). The launcher
 * shim (`./herdr-relay`) has already made sure every module `deno.lock` pins is cached.
 */

import { LSOF, NETSTAT, PROC_NET_TCP, PS } from "../src/auth/peer.ts";
import { ConfigError, homeFrom, stateDirOf } from "../src/config.ts";
import { MIRROR_CACHE_DIR } from "../src/mirror.ts";
import { type Platform, TAILSCALE_BIN_ENV } from "../src/platform.ts";
import { bridgeDenyReadUnderHome } from "../src/policy/scripts.ts";
import { PUSH_SERVICE_HOSTS } from "../src/push/webpush.ts";
import { noteEnvironment } from "./environment.ts";
import type { LauncherHost } from "./host.ts";

/** The bridge entry, relative to the repository. */
export const BRIDGE_ENTRY = "packages/bridge/src/main.ts";
/** The launcher entry, relative to the repository. */
export const LAUNCHER_ENTRY = "packages/bridge/bin/herdr-relay.ts";
/** Module loading: no prompt, nothing downloaded, no npm, the repository's lock, JSR imports only. */
export const MODULE_FLAGS = [
  "--no-prompt",
  "--cached-only",
  "--no-npm",
  "--lock=deno.lock",
  "--allow-import=jsr.io:443",
] as const;
/** The variables the bridge reads (`config.ts`, `platform.ts`). */
export const BRIDGE_ENV = [
  "HOME",
  "TMPDIR",
  "HERDR_APP_HOME",
  "HERDR_RELAY_PORT",
  "HERDR_RELAY_DEV",
  "PATH",
  TAILSCALE_BIN_ENV,
] as const;
/** The programs each sandbox provider starts hosts with (`hosts/sandbox.ts` ids). */
const SANDBOX_PROGRAMS: Readonly<Record<string, readonly string[]>> = { seatbelt: ["sandbox-exec"] };

export interface BridgeFlagInput {
  platform: Platform;
  /** `HOME` (absolute, no trailing slash). */
  home: string;
  /** `TMPDIR` as set (kept verbatim, as `deno task` expands `$TMPDIR`); unset or empty: the platform's. */
  tmpDir?: string;
  /** `HERDR_APP_HOME` as set; unset or empty: `$HOME/.config/herdr-app`. */
  appHome?: string;
}

/** The arguments after `deno` that start the bridge, run in the repository root. */
export function bridgeArgs(i: BridgeFlagInput): string[] {
  const { platform, home } = i;
  const tmp = i.tmpDir || platform.tmpDir;
  if (!tmp.startsWith("/")) throw new ConfigError("TMPDIR must be an absolute path");
  if (i.appHome && !i.appHome.startsWith("/")) throw new ConfigError("HERDR_APP_HOME must be an absolute path");
  const appHome = i.appHome ? i.appHome.replace(/(.)\/+$/, "$1") : `${home}/.config/herdr-app`;
  const runRoot = `${tmp}/herdr-relay`;
  const tmpRoots = platform.os === "darwin" ? ["/tmp", "/private/tmp"] : ["/tmp"];
  const read = [home, ...tmpRoots, runRoot, "./packages", "./deno.json"];
  if (![home, ...tmpRoots].some((root) => appHome === root || appHome.startsWith(`${root}/`))) read.push(appHome);
  if (platform.peerCheck === "proc-net-tcp") read.push(...PROC_NET_TCP);
  const run = [
    "hc",
    "herdr-app",
    "git",
    "deno",
    ...(SANDBOX_PROGRAMS[platform.sandbox?.id ?? ""] ?? []),
    platform.tailscaleBin,
    "cockpit",
    ...(platform.peerCheck === "netstat-lsof" ? [NETSTAT, PS, LSOF] : []),
  ];
  const lists: [string, string[]][] = [
    ["--allow-read", read],
    ["--deny-read", bridgeDenyReadUnderHome(platform).map((p) => `${home}/${p}`)],
    ["--allow-write", [stateDirOf(home), runRoot, `${appHome}/${MIRROR_CACHE_DIR}`]],
    ["--allow-net", ["127.0.0.1", ...PUSH_SERVICE_HOSTS.map((host) => `${host}:443`)]],
    ["--allow-env", [...BRIDGE_ENV]],
    ["--allow-run", run],
  ];
  const flags = lists.map(([flag, items]) => {
    // A comma would split the list; Deno has no escape for it.
    const bad = items.find((item) => item.includes(","));
    if (bad !== undefined) throw new ConfigError(`cannot grant a path containing a comma: ${bad}`);
    return `${flag}=${items.join(",")}`;
  });
  return ["run", ...MODULE_FLAGS, ...flags, BRIDGE_ENTRY];
}

/** `arg` for a POSIX shell: as is when it needs no quoting, else single-quoted. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

export interface StartOptions {
  host: LauncherHost;
  /** `<state>`: `environment.json` goes there. */
  stateDir: string;
  /** `--print-flags`: print the command (relative to the repository) instead of running it. */
  printOnly: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** `herdr-relay start [--print-flags]`; resolves to the exit code (the bridge's own when it ran). */
export async function start(o: StartOptions): Promise<number> {
  const { host } = o;
  let platform: Platform;
  let args: string[];
  try {
    platform = host.platform();
    args = bridgeArgs({
      platform,
      home: homeFrom(host.env),
      tmpDir: host.env.get("TMPDIR"),
      appHome: host.env.get("HERDR_APP_HOME"),
    });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    o.err(`herdr-relay: ${e.message}`);
    return 2;
  }
  if (o.printOnly) {
    o.out(["deno", ...args].map(shellQuote).join(" "));
    return 0;
  }
  await noteEnvironment({ host, stateDir: o.stateDir, platform, err: o.err });
  return await host.runBridge(args, host.repo);
}
