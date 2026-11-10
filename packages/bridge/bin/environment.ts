/**
 * `<state>/environment.json` (OSS-PLAN §5 upgrade path, T44): the operating system and the `deno` the bridge last
 * started with. The Seatbelt profile was derived for one macOS and one Deno (`src/hosts/seatbelt.template.sb`
 * header); when either changed since the last start, `herdr-relay start` prompts to re-run the derivation check and
 * `doctor` reports it. `start` rewrites the file every run; one with a higher `v` (a newer herdr-relay) is left alone.
 */

import { join } from "@std/path";
import { ensureStateDir } from "../src/auth/token.ts";
import { messageOf } from "../src/core/errors.ts";
import type { Platform } from "../src/platform.ts";
import type { LauncherHost } from "./host.ts";

export const ENVIRONMENT_FILE = "environment.json";
/** The `v` this herdr-relay reads and writes. */
export const ENVIRONMENT_VERSION = 1;

/** The Seatbelt derivation check, run in the repository (`packages/bridge/scripts/seatbelt-derive.ts` header). */
export const SEATBELT_DERIVE_COMMAND = "deno run --allow-read --allow-write --allow-net=127.0.0.1 --allow-env " +
  "--allow-run=deno,sandbox-exec packages/bridge/scripts/seatbelt-derive.ts";

export interface EnvironmentRecord {
  v: typeof ENVIRONMENT_VERSION;
  /** When `herdr-relay start` recorded it (ISO 8601). */
  recordedAt: string;
  /** `Deno.build.os`. */
  os: string;
  arch: string;
  /** macOS: `sw_vers`' `ProductVersion (BuildVersion)`; elsewhere the kernel release; null when unknown. */
  osVersion: string | null;
  /** The `deno` the bridge runs (`PATH`'s, as its `--allow-run=deno` resolves it) and what `deno --version` says. */
  deno: { path: string; version: string | null };
}

export type RecordedEnvironment =
  | { kind: "absent" }
  | { kind: "ok"; record: EnvironmentRecord }
  | { kind: "newer"; v: number }
  | { kind: "invalid"; reason: string };

/** The `deno` version a `deno --version` output names, or null. */
export function denoVersionOf(stdout: string): string | null {
  return /^deno (\d+\.\d+\.\d+\S*)/m.exec(stdout)?.[1] ?? null;
}

/** This machine now. */
export async function currentEnvironment(host: LauncherHost, os: Platform["os"]): Promise<EnvironmentRecord> {
  const [deno, osVersion] = await Promise.all([
    host.exec("deno", ["--version"]).then((r) => (r.code === 0 ? denoVersionOf(r.stdout) : null), () => null),
    os === "darwin"
      ? host.exec("/usr/bin/sw_vers", []).then((r) => {
        const field = (name: string) => new RegExp(`^${name}:\\s*(\\S+)`, "m").exec(r.stdout)?.[1];
        const product = field("ProductVersion");
        const build = field("BuildVersion");
        return r.code === 0 && product ? (build ? `${product} (${build})` : product) : null;
      }, () => null)
      : Promise.resolve(host.osRelease()),
  ]);
  return {
    v: ENVIRONMENT_VERSION,
    recordedAt: new Date().toISOString(),
    os,
    arch: host.arch,
    osVersion,
    deno: { path: host.denoPath(), version: deno },
  };
}

/** `<state>/environment.json` as recorded by the last start. */
export async function readEnvironment(stateDir: string): Promise<RecordedEnvironment> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(stateDir, ENVIRONMENT_FILE));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return { kind: "absent" };
    return { kind: "invalid", reason: messageOf(e) };
  }
  let data: Partial<EnvironmentRecord> & { v?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "not JSON" };
  }
  if (typeof data?.v === "number" && data.v > ENVIRONMENT_VERSION) return { kind: "newer", v: data.v };
  const ok = data?.v === ENVIRONMENT_VERSION && typeof data.recordedAt === "string" && typeof data.os === "string" &&
    typeof data.arch === "string" && (data.osVersion === null || typeof data.osVersion === "string") &&
    typeof data.deno?.path === "string" && (data.deno.version === null || typeof data.deno.version === "string");
  return ok ? { kind: "ok", record: data as EnvironmentRecord } : { kind: "invalid", reason: "not a v1 record" };
}

/** What changed between two records, one phrase each (empty: nothing). */
export function environmentChanges(before: EnvironmentRecord, now: EnvironmentRecord): string[] {
  const out: string[] = [];
  const unknown = (value: string | null) => value ?? "unknown";
  if (before.os !== now.os || before.arch !== now.arch) {
    out.push(`platform ${before.os}/${before.arch} → ${now.os}/${now.arch}`);
  }
  if (before.osVersion !== now.osVersion) {
    const name = now.os === "darwin" ? "macOS" : `${now.os} kernel`;
    out.push(`${name} ${unknown(before.osVersion)} → ${unknown(now.osVersion)}`);
  }
  if (before.deno.version !== now.deno.version) {
    out.push(`Deno ${unknown(before.deno.version)} → ${unknown(now.deno.version)}`);
  }
  if (before.deno.path !== now.deno.path) out.push(`deno ${before.deno.path} → ${now.deno.path}`);
  return out;
}

/** What to do about changes on `platform` (the prompt's second sentence). */
export function rederivePrompt(platform: Platform): string {
  return platform.sandbox?.id === "seatbelt"
    ? `the Seatbelt profile was derived for the previous ones: re-run its check in the repository: ${SEATBELT_DERIVE_COMMAND}`
    : "re-check the mod-host sandbox for this environment";
}

/**
 * `start`'s step: compares this machine with the last start's record, prints the re-derivation prompt on a change,
 * then records this machine. Never fails the start: problems are printed.
 */
export async function noteEnvironment(
  o: { host: LauncherHost; stateDir: string; platform: Platform; err: (line: string) => void },
): Promise<void> {
  const now = await currentEnvironment(o.host, o.platform.os);
  const recorded = await readEnvironment(o.stateDir);
  if (recorded.kind === "newer") {
    o.err(`herdr-relay: ${ENVIRONMENT_FILE} has version ${recorded.v}, written by a newer herdr-relay; left unchanged`);
    return;
  }
  if (recorded.kind === "invalid") o.err(`herdr-relay: ${ENVIRONMENT_FILE} (${recorded.reason}) is replaced`);
  if (recorded.kind === "ok") {
    const changes = environmentChanges(recorded.record, now);
    if (changes.length > 0) {
      o.err(`herdr-relay: since the last start: ${changes.join(", ")}; ${rederivePrompt(o.platform)}`);
    }
  }
  try {
    await ensureStateDir(o.stateDir);
    const path = join(o.stateDir, ENVIRONMENT_FILE);
    const tmp = `${path}.${Deno.pid}.tmp`;
    await Deno.writeTextFile(tmp, `${JSON.stringify(now, null, 2)}\n`, { mode: 0o600 });
    await Deno.rename(tmp, path);
  } catch (e) {
    o.err(`herdr-relay: cannot record ${ENVIRONMENT_FILE}: ${messageOf(e)}`);
  }
}
