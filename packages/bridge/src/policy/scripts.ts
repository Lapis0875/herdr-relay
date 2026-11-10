/**
 * Scoped `deno run` profiles for exec'd scripts (DESIGN-v2 §2.5) and their spawner. Known scripts are keyed by path
 * relative to the real appHome; the profile (Deno flags + environment) is what is pinned, not the script's bytes.
 * Every runner has `--no-prompt --no-config --no-remote --no-npm --no-lock`, a cleared environment and
 * `DENO_DIR=<run>/deno-dir/scripts`. Node is never used.
 *
 * Measured deviations from the §2.5 table (T05, Deno 2.9.8), recorded here so the profile stays the single truth:
 * - `lh-scan`: `node:child_process.execFileSync("ps")` reads the whole environment and resolves `ps` through `PATH`,
 *   so the profile grants `--allow-env` (unscoped; the environment is cleared to HOME, NO_COLOR, PATH=/bin and
 *   DENO_DIR) instead of `--allow-env=HOME`. With `--allow-env=HOME` the script still exits 0 but `ps` is refused and
 *   roots without a session never resolve.
 * - `lh-scan`: the script's own real path is added to `--allow-read` (it is outside `$HOME` when appHome is).
 * - `sync`: `$HOME/.cache/lstack-herdr` is readable and writable (sync.mjs stages the new fork there and renames it in;
 *   a rename needs read and write on both ends). `--check` runs completely under this profile. A real run still
 *   stops at sync.mjs's atomic writes, whose temp siblings (`layouts/.lstack-herdr.json.lstack-<pid>`,
 *   `.keys.json.lstack-<pid>` in appHome itself) are outside the pinned write set; covering them means write access to
 *   `<appHome>/layouts` and `<appHome>`. That only matters if U2 becomes "allow" (pending user confirmation).
 * - `picture`: the destination file is readable (`[ -s "$1" ]` needs a stat).
 */

import { dirname, join } from "@std/path";
import type { ScriptRunner } from "@herdr-relay/protocol";
import { hostPlatform, type Platform } from "../platform.ts";
import type { ExecResult } from "./decision.ts";
import { resolveAllowedCommand, runCapped } from "./spawn.ts";

export type ScriptProfile = ScriptRunner | "picture";

/**
 * The lstack mods' scripts by real path relative to the real appHome (a folder's policy profile names its own in
 * `scripts`; `profiles/lstack-herdr.json` pins these, and a context without profiles uses them). DESIGN-v2 §2.5 names
 * `mods/lstack-herdr/lh-scan.mjs`; that folder's copy actually lives at `components/lh-scan.mjs` (fixture).
 */
export const KNOWN_SCRIPTS: Readonly<Record<string, ScriptRunner>> = {
  "mods/lstack-herdr-cockpit/lh-scan.mjs": "lh-scan",
  "mods/lstack-herdr/components/lh-scan.mjs": "lh-scan",
  "mods/lstack-herdr/sync.mjs": "sync",
};

/** `lh-scan.mjs` subcommands (its CLI dispatch). A `Set`: a mod's string must not match `constructor` and the like. */
export const LH_SCAN_SUBCOMMANDS: ReadonlySet<string> = new Set(["tree", "detail", "run", "call", "transcript"]);
/** Arguments allowed after the subcommand. */
export const LH_SCAN_MAX_ARGS = 3;
/** `sync.mjs` options a device may pass (`--home` would point it at another tree). */
export const SYNC_OPTIONS: ReadonlySet<string> = new Set(["--json", "--check"]);

/**
 * The bridge's `--deny-read` list, relative to `$HOME` (DESIGN-v2 §1.2): the platform's credential and browser-data
 * paths (`../platform.ts`, G10) and the device list's backup. `lh-scan` adds `<state>`.
 */
export function bridgeDenyReadUnderHome(platform: Platform = hostPlatform()): string[] {
  return [...platform.denyReadUnderHome, ".herdr/herdr-relay/devices.json.bak"];
}

export const SCRIPT_COMMON_FLAGS = ["--no-prompt", "--no-config", "--no-remote", "--no-npm", "--no-lock"] as const;

/** Deadlines per profile (ms). */
export const SCRIPT_TIMEOUT_MS: Readonly<Record<ScriptProfile, number>> = {
  "lh-scan": 30_000,
  sync: 60_000,
  picture: 25_000,
};

/** Largest picture `fetch-picture.ts` stores. */
export const PICTURE_MAX_BYTES = 20 * 1024 * 1024;

/** Real paths a profile is built from. */
export interface RunnerPaths {
  /** The user's `$HOME` (real). */
  home: string;
  /** `<appHome>` (real). */
  appHome: string;
  /** `<state>` = `~/.herdr/herdr-relay` (as the bridge uses it). */
  state: string;
  /** `<run>` = `$TMPDIR/herdr-relay/<run-id>` (created by the bridge, 0700). */
  run: string;
  /** Repository root (for bridge-authored scripts). */
  repo: string;
}

/** One scoped `deno run`: everything needed to spawn it, nothing decided at spawn time. */
export interface ScopedRun {
  profile: ScriptProfile;
  /** Real path of the entry script. */
  script: string;
  args: string[];
  /** Permission flags (after the common flags). */
  flags: string[];
  /** The complete environment (`clearEnv`). */
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
}

export function scriptsDenoDir(run: string): string {
  return join(run, "deno-dir", "scripts");
}

/** `lh-scan.mjs <sub> <≤3 args>` (rule E1). `script` is the known script's real path. */
export function lhScanRun(paths: RunnerPaths, script: string, args: readonly string[]): ScopedRun {
  const deny = [...bridgeDenyReadUnderHome().map((p) => join(paths.home, p)), paths.state];
  return {
    profile: "lh-scan",
    script,
    args: [...args],
    flags: [
      `--allow-read=${paths.home},${script}`,
      `--deny-read=${deny.join(",")}`,
      `--allow-write=${join(paths.home, ".cache/lstack-herdr")}`,
      "--allow-env",
      "--allow-sys=homedir",
      "--allow-run=/bin/ps",
    ],
    env: { HOME: paths.home, NO_COLOR: "1", PATH: "/bin", DENO_DIR: scriptsDenoDir(paths.run) },
    cwd: dirname(script),
    timeoutMs: SCRIPT_TIMEOUT_MS["lh-scan"],
  };
}

/** `sync.mjs [--check] [--json]` (rule E2, only when U2 allows it). */
export function syncRun(paths: RunnerPaths, script: string, args: readonly string[]): ScopedRun {
  const staging = join(paths.home, ".cache/lstack-herdr");
  const writable = [
    join(paths.appHome, "mods/lstack-herdr-cockpit"),
    join(paths.appHome, "layouts/lstack-herdr.json"),
    join(paths.appHome, "layouts/lstack-herdr.svg"),
    join(paths.appHome, "keys.json"),
    staging,
  ];
  return {
    profile: "sync",
    script,
    args: [...args],
    flags: [
      `--allow-read=${paths.appHome},${staging}`,
      `--allow-write=${writable.join(",")}`,
      "--allow-env=HOME",
      "--allow-sys=homedir",
    ],
    env: { HOME: paths.home, NO_COLOR: "1", DENO_DIR: scriptsDenoDir(paths.run) },
    cwd: dirname(script),
    timeoutMs: SCRIPT_TIMEOUT_MS.sync,
  };
}

/** The picture folder pictures are stored in (`<appHome>/data/cockpit/show`). */
export function pictureDir(appHome: string): string {
  return join(appHome, "data/cockpit/show");
}

export type PictureRequest =
  | { variant: "remote"; dest: string; url: URL }
  | { variant: "local"; dest: string; src: string };

/**
 * `fetch-picture.ts remote|local <dest> <src>` (rule E15): replaces the show mod's `sh -c` literals. `dest` is the
 * real (possibly not yet existing) destination under `pictureDir(appHome)`; `src` the real local file.
 */
export function pictureRun(paths: RunnerPaths, req: PictureRequest): ScopedRun {
  const dir = pictureDir(paths.appHome);
  const port = req.variant === "remote" ? (req.url.port || (req.url.protocol === "https:" ? "443" : "80")) : "";
  const flags = req.variant === "remote"
    ? [`--allow-net=${req.url.hostname}:${port}`, `--allow-read=${req.dest}`]
    : [`--allow-read=${req.src},${req.dest}`];
  flags.push(`--allow-write=${dir}`, "--allow-run=/usr/bin/sips");
  return {
    profile: "picture",
    script: join(paths.repo, "packages/bridge/scripts/fetch-picture.ts"),
    args: [req.variant, req.dest, req.variant === "remote" ? req.url.href : req.src, String(PICTURE_MAX_BYTES)],
    flags,
    env: { NO_COLOR: "1", DENO_DIR: scriptsDenoDir(paths.run) },
    cwd: paths.run,
    timeoutMs: SCRIPT_TIMEOUT_MS.picture,
  };
}

/** The `deno` argv of a scoped run. */
export function scopedArgv(run: ScopedRun): string[] {
  return ["run", ...SCRIPT_COMMON_FLAGS, ...run.flags, run.script, ...run.args];
}

/**
 * Spawns a scoped run as the `deno` the bridge's `--allow-run=deno` resolved (by absolute path, because the runner's
 * own `PATH` would otherwise be used to find it; `Deno.execPath()` may name the Cellar path, which does not match)
 * with a cleared environment. `timeoutMs` (a mod's own, already capped) can only shorten the profile's deadline.
 */
export async function runScoped(run: ScopedRun, timeoutMs = run.timeoutMs): Promise<ExecResult> {
  await Deno.mkdir(run.env.DENO_DIR, { recursive: true, mode: 0o700 });
  return runCapped({
    command: resolveAllowedCommand("deno"),
    args: scopedArgv(run),
    cwd: run.cwd,
    env: run.env,
    clearEnv: true,
    timeoutMs: Math.min(timeoutMs, run.timeoutMs),
  });
}
