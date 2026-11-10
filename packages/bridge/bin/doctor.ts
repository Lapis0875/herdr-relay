/**
 * `herdr-relay doctor` (OSS-PLAN §5 upgrade path, T44): one line per check, `ok`, `warn`, `info` or `FAIL`, then a
 * count; exit 1 when anything failed. Read-only: it runs `deno --version`, `sw_vers`, the sandbox probe, `tailscale
 * status --json` and `tailscale serve status --json`, `herdr-app --version` and `herdr-app commands`, and a
 * `deno install --cached-only --frozen` check that downloads and writes nothing; it asks a running bridge for the
 * mirror status on 127.0.0.1.
 *
 * Checks: deno (≥ 2.9), platform (against `<state>/environment.json`), sandbox, access mode (Tailscale only in v1,
 * DECISIONS O3), Tailscale CLI and login, `tailscale serve` of the mount, Herdr compatibility (`compatDoctorLines`),
 * lock cache, paired devices (`devices.json` version), the mirror mod (installed vs bundled version) and the bridge
 * with its mirror status.
 */

import { join } from "@std/path";
import { DeviceStore, parseServeStatus, planServe, readToken, type TailscaleRun, whoami } from "../src/auth/mod.ts";
import { compatDoctorLines } from "../src/compat/doctor.ts";
import { compareVersions } from "../src/compat/pins.ts";
import { ConfigError, DEFAULT_PATH, homeFrom, MOUNT } from "../src/config.ts";
import { messageOf } from "../src/core/errors.ts";
import type { HerdrAppEnv } from "../src/herdr/version.ts";
import {
  BUNDLED_RELAY_MOD,
  MIRROR_CACHE_DIR,
  MIRROR_CACHE_FILE,
  MIRROR_ENDPOINT_FILE,
  MIRROR_PATH,
  type MirrorStatus,
} from "../src/mirror.ts";
import type { Platform } from "../src/platform.ts";
import {
  currentEnvironment,
  ENVIRONMENT_FILE,
  environmentChanges,
  readEnvironment,
  rederivePrompt,
} from "./environment.ts";
import type { LauncherHost } from "./host.ts";
import { MIRROR_MOD, modVersion } from "./install-mod.ts";
import { BRIDGE_ENTRY, LAUNCHER_ENTRY } from "./start.ts";

/** The oldest Deno herdr-relay runs on (`docs/INSTALL.md`). */
export const DENO_MIN = "2.9.0";
/** How long doctor waits for the running bridge. */
const BRIDGE_TIMEOUT_MS = 2_000;

/** The lock-cache check: every module the launcher and the bridge load is cached at its locked version. */
export const LOCK_CHECK_ARGS = [
  "install",
  "--entrypoint",
  "--cached-only",
  "--frozen",
  "--no-npm",
  "--no-check",
  "--lock=deno.lock",
  LAUNCHER_ENTRY,
  BRIDGE_ENTRY,
] as const;

type Level = "ok" | "info" | "warn" | "FAIL";

export interface DoctorOptions {
  host: LauncherHost;
  stateDir: string;
  /** The Tailscale CLI (stubbed in tests). */
  tailscale: TailscaleRun;
  /** `HERDR_RELAY_PORT` (the port `serve` publishes). */
  port: number;
  out: (line: string) => void;
  /** Herdr compatibility lines; default `compatDoctorLines`. */
  compat?: (o: HerdrAppEnv) => Promise<string[]>;
  /** HTTP to the running bridge; default `fetch`. */
  fetch?: typeof fetch;
}

/** Runs every check; resolves to the exit code (1 when any check failed). */
export async function doctor(o: DoctorOptions): Promise<number> {
  const counts: Record<Level, number> = { ok: 0, info: 0, warn: 0, FAIL: 0 };
  const say = (level: Level, label: string, text: string, more: readonly string[] = []) => {
    counts[level]++;
    o.out(`${level.padEnd(5)} ${label}: ${text}`);
    for (const line of more) o.out(`${" ".repeat(6)}${line}`);
  };
  const { host } = o;
  let platform: Platform;
  let home: string;
  try {
    platform = host.platform();
    home = homeFrom(host.env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    say("FAIL", "platform", e.message);
    return finish(o, counts);
  }
  const appHome = host.env.get("HERDR_APP_HOME")?.replace(/(.)\/+$/, "$1") || `${home}/.config/herdr-app`;

  // deno and the platform, against the last start's record.
  const now = await currentEnvironment(host, platform.os);
  const deno = now.deno.version;
  if (deno === null) say("FAIL", "deno", `${now.deno.path} --version did not name a version`);
  else if (compareVersions(deno, DENO_MIN) < 0) say("FAIL", "deno", `${deno} at ${now.deno.path}; needs ${DENO_MIN}+`);
  else say("ok", "deno", `${deno} at ${now.deno.path}`);
  const system = `${platform.label} ${now.osVersion ?? "(version unknown)"}, ${now.arch}`;
  const recorded = await readEnvironment(o.stateDir);
  if (recorded.kind === "absent") say("info", "platform", `${system}; no start recorded yet (${ENVIRONMENT_FILE})`);
  else if (recorded.kind === "newer") {
    say("warn", "platform", `${system}; ${ENVIRONMENT_FILE} is version ${recorded.v}, from a newer herdr-relay`);
  } else if (recorded.kind === "invalid") {
    say("warn", "platform", `${system}; ${ENVIRONMENT_FILE}: ${recorded.reason} (the next start rewrites it)`);
  } else {
    const changes = environmentChanges(recorded.record, now);
    if (changes.length === 0) say("ok", "platform", `${system}; as at the last start (${recorded.record.recordedAt})`);
    else {
      say(
        "warn",
        "platform",
        `${system}; since the last start (${recorded.record.recordedAt}): ${changes.join(", ")}`,
        [
          rederivePrompt(platform),
        ],
      );
    }
  }

  // The mod-host sandbox.
  if (platform.sandbox === null) {
    say(
      "FAIL",
      "sandbox",
      `none for ${platform.label} yet: the bridge starts only with HERDR_RELAY_DEV=insecure-no-sandbox`,
    );
  } else if (await platform.sandbox.available()) say("ok", "sandbox", `${platform.sandbox.label} works`);
  else say("FAIL", "sandbox", platform.sandbox.unavailable);

  // Network access: Tailscale (the only mode in v1) and the published mount.
  say("info", "access", "tailscale (the only access mode in v1)");
  const me = await whoami(o.tailscale);
  if (me === null) {
    say(
      "warn",
      "tailscale",
      `${platform.tailscaleBin}: not running or not logged in (devices cannot reach the bridge)`,
    );
  } else {
    say("ok", "tailscale", `${platform.tailscaleBin}: ${me.owner} on ${me.dns}`);
    const status = await o.tailscale(["serve", "status", "--json"]);
    if (!status.ok) say("warn", "serve", `cannot read tailscale serve status: ${status.out.trim()}`);
    else {
      let line: [Level, string];
      try {
        const state = parseServeStatus(status.out, me.dns);
        const plan = planServe(state, o.port);
        const url = `https://${me.dns}${MOUNT}/`;
        line = state.funnel.length > 0
          ? ["FAIL", `Funnel is on for ${state.funnel.join(", ")}; herdr-relay must stay tailnet-only`]
          : plan.kind === "already"
          ? ["ok", `${url} → ${plan.proxy}`]
          : plan.kind === "run"
          ? ["warn", `${url} is not published: herdr-relay serve`]
          : ["warn", plan.reason];
      } catch {
        line = ["warn", "tailscale serve status --json is not JSON"];
      }
      say(line[0], "serve", line[1]);
    }
  }

  // Herdr.
  const PATH = host.env.get("PATH") || DEFAULT_PATH;
  const compat = await (o.compat ?? compatDoctorLines)({ home, appHome, PATH }).catch((e) => [
    `not compared: ${messageOf(e)}`,
  ]);
  const concern = compat.some((line) => /not tested|^drift|^not compared|^device banner/.test(line));
  say(concern ? "warn" : "ok", "herdr", compat[0] ?? "no compatibility report", compat.slice(1));

  // The locked dependencies.
  const lock = await host.exec("deno", [...LOCK_CHECK_ARGS], host.repo).catch((e) => ({
    code: -1,
    stdout: "",
    stderr: messageOf(e),
  }));
  if (lock.code === 0) say("ok", "lock", "every module deno.lock pins for the launcher and the bridge is cached");
  else {
    say("FAIL", "lock", lock.stderr.trim().split("\n")[0] || `deno install exited ${lock.code}`, [
      "the herdr-relay launcher fetches them before its next command (deno install --entrypoint --frozen …)",
    ]);
  }

  // Paired devices.
  try {
    const list = await new DeviceStore(o.stateDir).list();
    say("ok", "devices", `${list.length} paired`);
  } catch (e) {
    say("FAIL", "devices", messageOf(e));
  }

  // The mirror mod and the running bridge.
  const modDir = join(appHome, "mods", MIRROR_MOD);
  const installed = await modVersion(modDir).catch(() => null);
  if (installed === null) {
    const absent = !(await Deno.lstat(modDir).then(() => true, () => false));
    say(
      "warn",
      "mirror",
      absent
        ? `not installed in ${join(appHome, "mods")}: herdr-relay install-mod`
        : `${modDir}/mod.json has no readable version`,
    );
  } else {
    const order = compareVersions(installed, BUNDLED_RELAY_MOD);
    if (order < 0) {
      say("warn", "mirror", `${installed} installed, older than ${BUNDLED_RELAY_MOD}: herdr-relay install-mod`);
    } else if (order > 0) {
      say("warn", "mirror", `${installed} installed, newer than this herdr-relay's ${BUNDLED_RELAY_MOD}`);
    } else say("ok", "mirror", `${installed} installed in ${modDir}`);
  }
  const bridge = await bridgeStatus(o.stateDir, o.fetch ?? fetch);
  if (typeof bridge === "string") {
    say("info", "bridge", bridge);
    const cached = await lastSnapshot(join(appHome, MIRROR_CACHE_DIR, MIRROR_CACHE_FILE));
    if (cached !== null) say("info", "mirror", cached);
  } else {
    say("ok", "bridge", `running on 127.0.0.1:${bridge.port} (pid ${bridge.pid})`);
    const m = bridge.mirror;
    const from = m.relayMod ? ` from herdr-relay-mirror ${m.relayMod}` : "";
    if (m.state === "fresh") {
      say(m.outdated ? "warn" : "ok", "mirror", `fresh${from}${m.outdated ? " (outdated)" : ""}`);
    } else if (m.state === "stale") {
      say("warn", "mirror", `stale since ${m.receivedAt}${from}: is a layout with the mirror shown in Herdr?`);
    } else say("warn", "mirror", "no snapshot yet: add the mirror's entry to the layout Herdr shows");
  }
  return finish(o, counts);
}

function finish(o: DoctorOptions, counts: Record<Level, number>): number {
  o.out(`${counts.FAIL} failed, ${counts.warn} warning${counts.warn === 1 ? "" : "s"}, ${counts.ok} ok`);
  return counts.FAIL > 0 ? 1 : 0;
}

/** The running bridge and its mirror status, or why there is none. */
async function bridgeStatus(
  stateDir: string,
  fetcher: typeof fetch,
): Promise<{ port: number; pid: number; mirror: MirrorStatus } | string> {
  let endpoint: { port?: unknown; pid?: unknown };
  try {
    endpoint = JSON.parse(await Deno.readTextFile(join(stateDir, MIRROR_ENDPOINT_FILE)));
  } catch (e) {
    return e instanceof Deno.errors.NotFound
      ? "not running (herdr-relay start)"
      : `${MIRROR_ENDPOINT_FILE}: ${messageOf(e)}`;
  }
  const { port, pid } = endpoint;
  if (typeof port !== "number" || typeof pid !== "number") return `${MIRROR_ENDPOINT_FILE} is malformed`;
  let token: string | null;
  try {
    token = await readToken(stateDir);
  } catch (e) {
    return messageOf(e);
  }
  if (token === null) return "no loopback token: not running (herdr-relay start)";
  try {
    const res = await fetcher(`http://127.0.0.1:${port}${MOUNT}${MIRROR_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    if (!res.ok) return `127.0.0.1:${port} answered HTTP ${res.status} (another program on its port?)`;
    return { port, pid, mirror: await res.json() };
  } catch {
    return `not running (${MIRROR_ENDPOINT_FILE} names port ${port}, pid ${pid}, which does not answer)`;
  }
}

/** The cached snapshot's age and sender, or null without a cache. */
async function lastSnapshot(path: string): Promise<string | null> {
  try {
    const file = JSON.parse(await Deno.readTextFile(path));
    const relayMod = typeof file?.snapshot?.relayMod === "string"
      ? ` from herdr-relay-mirror ${file.snapshot.relayMod}`
      : "";
    return typeof file?.receivedAt === "string" ? `last snapshot ${file.receivedAt}${relayMod}` : null;
  } catch {
    return null;
  }
}
