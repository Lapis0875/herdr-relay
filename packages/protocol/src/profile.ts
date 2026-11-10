/**
 * Policy profiles (OSS-PLAN §1): a data file that opts known mod folders into more than the `default` profile gives
 * every folder (read its own folder, `data/<folder>` and the space folders; no exec, hc or net). The bridge loads the
 * built-ins (`packages/bridge/profiles/*.json`) and the user's (`<state>/profiles/*.json`); a file holds one profile or
 * a list of them. Invariants: rows stay code (argument-level checks and tests), a profile only enables rows and names
 * values the rows look up (script paths → code-defined runners, `sh -c` literal hashes → bridge-native replacements);
 * a folder named by several profiles gets the one with the highest `priority` (default 0 for built-ins, 10 for user
 * profiles; at equal priority a user profile wins, then the lower id).
 *
 * Path patterns (`reads`, `writes`): `/`-separated, no `.`, `..` or empty segments. A last segment `**` means the
 * folder and everything under it; a last segment with `*` means the entries of that folder whose name matches (`*` =
 * any characters but `/`); otherwise the pattern is exactly that file. `{folder}` stands for the mod folder's name.
 * `appHome` patterns are relative to `<appHome>`; `extra` paths start with `~/` (`$HOME`), `/`, `$cockpit.cache/` or
 * `$cockpit.home/` (the `cache`/`home` that `<appHome>/cockpit.json` names; dropped while it names none).
 */

import { FOLDER_PATTERN } from "./control.ts";
import type { EXEC_RULES } from "./policy-log.ts";
import {
  array,
  boolean,
  define,
  enumOf,
  integer,
  object,
  record,
  type Static,
  string,
  union,
  validate,
} from "./schema.ts";

/** A profile id: what `hello.hosts[].profile` and `PolicyLogRecord.profile` carry. */
export const PROFILE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

/** The profile of every folder no profile names (built into the bridge; a file may not use the id). */
export const DEFAULT_PROFILE_ID = "default";

/** Exec rows a profile may enable; the others (E3, E8, E9, E12, E13, E16) are decided by code alone. */
export const PROFILE_EXEC_RULES = ["E1", "E2", "E4", "E5", "E6", "E7", "E10", "E11", "E14", "E15"] as const;
export type ProfileExecRule = (typeof PROFILE_EXEC_RULES)[number];
const _rulesAreExecRules: readonly (typeof EXEC_RULES)[number][] = PROFILE_EXEC_RULES;

/** Scoped `deno run` runner profiles (code, `scripts.ts`): `lh-scan` runs as E1, `sync` as E2. */
export const SCRIPT_RUNNERS = ["lh-scan", "sync"] as const;
export type ScriptRunner = (typeof SCRIPT_RUNNERS)[number];

/** What a pinned `sh -c` literal is replaced by: the native listing (E14) or `fetch-picture.ts` (E15). */
export const SH_LITERAL_KINDS = ["listing", "picture-remote", "picture-local"] as const;
export type ShLiteralKind = (typeof SH_LITERAL_KINDS)[number];

/** `device`: `mod.open` opens the overlay on a device; `host-only`: a device gets a toast instead. */
export const PROFILE_OVERLAYS = ["device", "host-only"] as const;

/** Where the cockpit hub port comes from (`<cockpit.json cache>/hub.json`). */
export const HUB_PORT_SOURCES = ["cockpit.json"] as const;

/**
 * What `net.write` admits on a hub connection (`net.writes`): `act` (the default) — only writes made for a connected
 * device with `act` scope, so neither a mod's own tasks nor `read` devices write; `cockpit-hub` — the bridge reads the
 * cockpit hub's newline-delimited JSON requests and decides each one by its `op` (reads for anyone, actions for a
 * connected `act` device, changes only the Herdr window makes for no one: `packages/bridge/src/policy/hub.table.ts`).
 */
export const NET_WRITE_MODES = ["act", "cockpit-hub"] as const;
export type NetWriteMode = (typeof NET_WRITE_MODES)[number];
/** `net.writes` when a profile enabling net does not name it. */
export const DEFAULT_NET_WRITE_MODE: NetWriteMode = "act";

const SEGMENT = String.raw`(?:[^/*{}\\\x00]|\{folder\})+`;
const LAST_SEGMENT = String.raw`(?:\*\*|(?:[^/{}\\\x00]|\{folder\})+)`;
const NO_DOT_SEGMENTS = String.raw`(?!(?:.*/)?\.\.?(?:/|$))`;
const PLAIN_SEGMENT = String.raw`[^/*{}\\\x00]+`;

/** A pattern relative to `<appHome>`. */
export const APP_HOME_PATTERN = `^${NO_DOT_SEGMENTS}(?:${SEGMENT}/)*${LAST_SEGMENT}$`;
/** A pattern under `~`, `/`, `$cockpit.cache` or `$cockpit.home`. */
export const EXTRA_PATH_PATTERN = String.raw`^${NO_DOT_SEGMENTS}(?:~|\$cockpit\.(?:cache|home))?/(?:${SEGMENT}/)*` +
  LAST_SEGMENT + "$";
/** A script path relative to `<appHome>`, inside `mods/<folder>/`. */
export const SCRIPT_PATH_PATTERN = `^${NO_DOT_SEGMENTS}mods/${FOLDER_PATTERN.slice(1, -1)}/(?:${PLAIN_SEGMENT}/)*` +
  `${PLAIN_SEGMENT}$`;
/** `>=0.1.13`, `0.1.14`, `>=0.1.13 <0.2.0`: every comparison must hold. */
export const HERDR_RANGE_PATTERN = String.raw`^(?:>=|<=|>|<|=)?\d+\.\d+\.\d+(?: (?:>=|<=|>|<|=)?\d+\.\d+\.\d+)*$`;

const appHomePatterns = () => array(string({ pattern: APP_HOME_PATTERN, maxLength: 512 }));
const extraPaths = () => array(string({ pattern: EXTRA_PATH_PATTERN, maxLength: 1024 }));

export const PolicyProfileSchema = define("PolicyProfile", () =>
  object({
    id: string({ pattern: PROFILE_ID_PATTERN }),
    folders: array(string({ pattern: FOLDER_PATTERN }), {
      minItems: 1,
      description: "exact mod folder names this profile governs",
    }),
  }, {
    $schema: string(),
    description: string(),
    priority: integer({
      minimum: 0,
      maximum: 1000,
      description: "the highest wins for a folder several profiles name; default 0 (built-in) or 10 (user)",
    }),
    requires: object({}, {
      herdr: string({ pattern: HERDR_RANGE_PATTERN, description: "a mismatch is logged; the profile still applies" }),
    }),
    reads: object({}, {
      appHome: appHomePatterns(),
      spaces: boolean({ description: "the space folders; default true" }),
      extra: extraPaths(),
    }, { description: "read roots besides the folder itself and data/<folder>" }),
    writes: object({}, { appHome: appHomePatterns(), extra: extraPaths() }, {
      description: "what this profile's runners write (only code-defined runners write); listed, not granted",
    }),
    exec: object({}, {
      rows: array(enumOf(PROFILE_EXEC_RULES)),
      git: object({}, {
        gitDirUnderRoots: boolean({ description: "E4 `--git-dir <dir>` with a value under the read roots" }),
      }),
    }),
    scripts: record(enumOf(SCRIPT_RUNNERS), {
      keys: SCRIPT_PATH_PATTERN,
      description: "script path relative to <appHome> → runner (E1 lh-scan, E2 sync)",
    }),
    shLiterals: record(enumOf(SH_LITERAL_KINDS), {
      keys: "^[0-9a-f]{64}$",
      description: "sha256 of an `sh -c` literal → its native replacement (E14 listing, E15 pictures)",
    }),
    net: object({ hubPortFrom: enumOf(HUB_PORT_SOURCES) }, {
      writes: enumOf(NET_WRITE_MODES, {
        description:
          "what net.write admits: act (default; a connected act device only) or cockpit-hub (each request by op)",
      }),
    }, {
      description: "net.connect to 127.0.0.1 at the cockpit hub's port",
    }),
    overlay: enumOf(PROFILE_OVERLAYS, { description: "default device" }),
  }));
export type PolicyProfile = Static<typeof PolicyProfileSchema>;

/** A profile file: one profile or a list of them. */
export const PolicyProfileFileSchema = union([PolicyProfileSchema, array(PolicyProfileSchema, { minItems: 1 })]);

/** Rows a script runner needs. */
const RUNNER_ROW: Readonly<Record<ScriptRunner, ProfileExecRule>> = { "lh-scan": "E1", sync: "E2" };
/** Rows an `sh -c` literal kind needs. */
const LITERAL_ROW: Readonly<Record<ShLiteralKind, ProfileExecRule>> = {
  listing: "E14",
  "picture-remote": "E15",
  "picture-local": "E15",
};

/** Problems the schema cannot express; empty when the profile is consistent. */
export function profileProblems(p: PolicyProfile): string[] {
  const out: string[] = [];
  if (p.id === DEFAULT_PROFILE_ID) out.push(`id "${DEFAULT_PROFILE_ID}" is reserved`);
  const dup = p.folders.find((f, i) => p.folders.indexOf(f) !== i);
  if (dup !== undefined) out.push(`folder ${dup} is listed twice`);
  const rows = new Set<string>(p.exec?.rows ?? []);
  for (const [script, runner] of Object.entries(p.scripts ?? {})) {
    const folder = script.split("/")[1];
    if (!p.folders.includes(folder)) out.push(`script ${script} is not in one of the profile's folders`);
    if (!rows.has(RUNNER_ROW[runner])) out.push(`script ${script} runs as ${RUNNER_ROW[runner]}, which is not enabled`);
  }
  for (const [hash, kind] of Object.entries(p.shLiterals ?? {})) {
    if (!rows.has(LITERAL_ROW[kind])) out.push(`sh literal ${hash.slice(0, 12)}… needs ${LITERAL_ROW[kind]}`);
  }
  return out;
}

export type ProfileFileValidation = { ok: true; profiles: PolicyProfile[] } | { ok: false; problems: string[] };

/** Validates a parsed profile file: schema, then each profile's consistency and unique ids within the file. */
export function validateProfileFile(value: unknown): ProfileFileValidation {
  const v = validate(PolicyProfileFileSchema, value);
  if (!v.ok) return { ok: false, problems: v.errors.map((e) => `${e.path || "/"}: ${e.message}`) };
  const profiles = Array.isArray(v.value) ? v.value : [v.value];
  const problems: string[] = [];
  profiles.forEach((p, i) => {
    if (profiles.findIndex((q) => q.id === p.id) !== i) problems.push(`profile id ${p.id} is used twice`);
    for (const problem of profileProblems(p)) problems.push(`${p.id}: ${problem}`);
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, profiles };
}

/** `major.minor.patch` of a version string (a pre-release suffix is ignored), or null. */
function parseVersion(text: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Whether a Herdr version satisfies a `requires.herdr` range; null when either cannot be read. */
export function herdrSatisfies(range: string, version: string): boolean | null {
  const have = parseVersion(version);
  if (have === null || !new RegExp(HERDR_RANGE_PATTERN).test(range)) return null;
  return range.split(" ").every((part) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(part)!;
    const c = compareVersions(have, parseVersion(m[2])!);
    switch (m[1]) {
      case ">=":
        return c >= 0;
      case "<=":
        return c <= 0;
      case ">":
        return c > 0;
      case "<":
        return c < 0;
      default:
        return c === 0;
    }
  });
}
