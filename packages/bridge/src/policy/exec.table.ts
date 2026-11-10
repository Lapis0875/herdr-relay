/**
 * The exec allowlist as data (DESIGN-v2 §2.3, rows E1–E16): which row describes a request, and the constants each
 * row's argument check uses. Derived from every `exec`/`hc` call site in Herdr's shipped mods (`fixtures/generic-home`,
 * Herdr 0.1.14; OSS-PLAN §2.1) and the lstack fork. Deciding a row (paths, scope, cockpit.json, the folder's policy
 * profile, the running Herdr version) and running it live in `exec.ts`; the U1–U3 switches in `user-decisions.ts`;
 * which programs open things on this computer (E11/E12) in `../platform.ts`. Tables looked up by a mod's strings are
 * `Set`s (or read with `Object.hasOwn`): a plain object would also answer `constructor`, `__proto__`, `toString`….
 */

import type { EXEC_RULES, ScriptRunner, ShLiteralKind } from "@herdr-relay/protocol";
import { hostPlatform, type Platform } from "../platform.ts";

/** An exec allowlist row id (`E1`–`E16`). */
export type ExecRule = (typeof EXEC_RULES)[number];

export interface ExecRow {
  rule: ExecRule;
  /** Call sites in the fixture mods. */
  callers: string;
  /** Argv form the row describes. */
  form: string;
  /** `conditional` = allowed only when the row's argument/scope checks pass. */
  decision: "allow" | "conditional" | "refuse" | "intercept";
  executedAs: string;
}

export const EXEC_TABLE: readonly ExecRow[] = [
  {
    rule: "E1",
    callers: "lh-tree-data.js:92/153/213/252, lh-transcript.js:80 (lstack-herdr-cockpit, lstack-herdr/components)",
    form: "node <appHome>/mods/<F>/lh-scan.mjs tree|detail|run|call|transcript <≤3 args, none starting with ->",
    decision: "conditional",
    executedAs: "scoped deno run, profile lh-scan",
  },
  {
    rule: "E2",
    callers: "lh-watch.js:167, lstack-herdr/main.js:32",
    form: "node <appHome>/mods/lstack-herdr/sync.mjs [--json]",
    decision: "conditional",
    executedAs: "scoped deno run, profile sync, --check first (only when U2 allows, act scope)",
  },
  {
    rule: "E3",
    callers: "any",
    form: "node with a flag (-e, --eval, -r, --import, --loader…) or an unknown/foreign script",
    decision: "refuse",
    executedAs: "—",
  },
  {
    rule: "E4",
    callers: "changes/main.js:71/74/126, files/main.js:92/96, spaces/main.js:206/214/215, menu/main.js:18–19, " +
      "worktree/main.js:31/33/65/72/73/76/85/90/100/101/145/186/211, sidebar.js:128, code.js:153",
    form: "git [-C <dir>] [--git-dir <dir>] [--no-optional-locks] [-c core.fsmonitor=false] " +
      "[-c diff.autoRefreshIndex=false] <RO> …; RO: rev-parse (incl. --git-dir, --git-common-dir, " +
      "--absolute-git-dir, --path-format=absolute, <rev>:<path>), status, diff (inside a work tree, operands " +
      "relative without ..), log, show, branch (listing; names only as patterns of a listing mode, `--` included), " +
      "ls-files, for-each-ref, show-ref [--verify] [--quiet] <ref>, cat-file -e <object>, " +
      "rev-list -n1 --all --not --remotes [<rev>], worktree list [--porcelain], " +
      "config (--file <f> | --blob <rev:path>) [-z] --get-regexp <re>. Denied options refused by any abbreviation. " +
      "--git-dir/--file/--blob only with the profile's gitDirUnderRoots (full spelling), values under the read " +
      "roots. `worktree add|remove`: refused, toast",
    decision: "conditional",
    executedAs: "git, env {HOME, PATH, GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0}",
  },
  {
    rule: "E5",
    callers: "changes/main.js:157–158",
    form: "git add -A | git commit -m <message> (cwd = repo root)",
    decision: "conditional",
    executedAs: "git, cleared env {HOME, PATH, TMPDIR, GIT_TERMINAL_PROMPT=0} (U1: act-scope devices only)",
  },
  {
    rule: "E6",
    callers: "spaces/main.js:128, picker/main.js:52, machine-add/main.js:92, win98/dialog.js:68, editor.js:22",
    form: "hc machine ls --json",
    decision: "allow",
    executedAs: "hc, cleared env {HOME, PATH}",
  },
  {
    rule: "E7",
    callers: "spaces/main.js:148 (machine rm/add: refused), machine-add/main.js:121 (host-only overlay)",
    form: "hc ls --json | hc terminal list --json | hc terminal get <id> --json | hc schema | hc --version; " +
      "`hc machine add|rm …`: refused, toast",
    decision: "conditional",
    executedAs: "hc, cleared env {HOME, PATH} (every other hc form refused)",
  },
  {
    rule: "E8",
    callers: "code.js:37",
    form: "env HERDR_APP_HOME=… <home>/.local/bin/herdr-app do pane.split <json> (any herdr-app from a mod)",
    decision: "refuse",
    executedAs: "—",
  },
  {
    rule: "E9",
    callers: "bridge run() pass-through (not a mod exec)",
    form: "herdr-app do <name> <json>",
    decision: "conditional",
    executedAs: "herdr-app, cleared env {HOME, PATH, HERDR_APP_HOME} (commands.json passthrough + act scope)",
  },
  {
    rule: "E10",
    callers: "hub.js:116 via cockpit()",
    form: "env HOME=<install.home> HERDR_APP_HOME=<appHome> COCKPIT_FRONTEND=app [K=V…] <install.bin> hub start",
    decision: "conditional",
    executedAs: "cockpit (the bridge's --allow-run=cockpit), cleared env: the checked assignments + PATH",
  },
  {
    rule: "E11",
    callers: "hub.js:19, win98/kit.js:398",
    form: "<the platform's opener: open on macOS> <http(s) url>",
    decision: "intercept",
    executedAs: "toast {action:{open:url}} to the originating device (U3); other open forms refused",
  },
  {
    rule: "E12",
    callers: "hub.js:20–21, files/main.js:22, win98/kit.js:398",
    form: "other platforms' openers: xdg-open | cmd /c start | powershell … (on macOS)",
    decision: "refuse",
    executedAs: "—",
  },
  {
    rule: "E13",
    callers: "editor.js:38/41/45, code.js:208",
    form: "<editor> <folder> | code -g <file:line> | code --folder-uri … | open -a <App> <folder>",
    decision: "refuse",
    executedAs: "—",
  },
  {
    rule: "E14",
    callers: "files/main.js:28–30",
    form: "sh -c <L1> files <path> (sha256 pinned by the profile and by the running Herdr version)",
    decision: "conditional",
    executedAs: "native directory listing (listing.ts), no shell",
  },
  {
    rule: "E15",
    callers: "show.js:238–244",
    form: "sh -c <L2 remote|local × macos|other> sh <appHome>/data/cockpit/show/<key> <src> (4 sha256 pinned)",
    decision: "conditional",
    executedAs: "scoped deno run of scripts/fetch-picture.ts, profile picture",
  },
  {
    rule: "E16",
    callers: "any; win98/taskbar.js:51/84, machine-add/main.js:27/150, worktree/main.js:136–137 (with `on`)",
    form: "any other sh, bash, zsh, env, cat, ls, curl, python, osascript, sips…",
    decision: "refuse",
    executedAs: "—",
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// E14 / E15: the pinned shell literals (sha256 of the string the mod passes after `-c`). A folder's profile names the
// literals it may use (`shLiterals`); these are the shipped and lstack mods' literals, which the built-in profiles
// pin, and what a context without profiles classifies by.

export const KNOWN_SH_LITERALS: Readonly<Record<string, ShLiteralKind>> = {
  // `files/main.js:28` directory listing.
  "a3163594cfb779a6a5beefd7c0aeb4a6838b8fce63061c24c245bbb6513d4231": "listing",
  // `show.js:238–241` pictures: fetch (`curl` remote / `cp` local) × size (`sips` on macOS / `file` elsewhere).
  "36d9dd22119b98c3137469d3a81cb794dddef92e72b28b4927a743832c5f3077": "picture-remote", // curl + sips
  "8ccdbeba4e41c336970ebe67520434e3d3f04864fb2a8d97e8fbec96d15dd0c4": "picture-remote", // curl + file
  "74851efd9c03019f3b5f242f13e1e192a4962adbd8ffcd621eca9a282156aecc": "picture-local", // cp + sips
  "14b0ce7719094c3578c5ba7a24960b9c1b28c8e8ab17f10587c1ca7066fae43c": "picture-local", // cp + file
};

/**
 * Herdr's own `sh -c` literals by release (E14): what `mods/files/main.js` passes in each listed Herdr version. 0.1.14
 * is checked against its contract (`fixtures/contract/0.1.14/`, the shipped mods synced at that tag in
 * `fixtures/generic-home`); other versions are listed only from the literal itself (no contract pins: their compat
 * stays "not tested"). A profile's pin of one of these runs only while the running Herdr is a listed version that
 * ships it: no known version, a version not listed here, or a literal that version does not ship is refused (the mod
 * shows its own error).
 */
export const HERDR_SH_LITERALS: Readonly<Record<string, Readonly<Record<string, ShLiteralKind>>>> = {
  // `defaults/mods/files/main.js` at herdrdev/herdr-app v0.1.13 is git blob fc3c7582c31371b675966b41aa69ebde0a07cc92
  // (GitHub contents API, 2026-11-10), the same blob as v0.1.14 and `fixtures/generic-home/mods/files/main.js`.
  "0.1.13": {
    // `files/main.js:28` directory listing.
    "a3163594cfb779a6a5beefd7c0aeb4a6838b8fce63061c24c245bbb6513d4231": "listing",
  },
  "0.1.14": {
    // `files/main.js:28` directory listing.
    "a3163594cfb779a6a5beefd7c0aeb4a6838b8fce63061c24c245bbb6513d4231": "listing",
  },
};

const HERDR_LITERAL_HASHES: ReadonlySet<string> = new Set(
  Object.values(HERDR_SH_LITERALS).flatMap((literals) => Object.keys(literals)),
);

/** Whether `sha256` is one of Herdr's own literals (of any listed release), so the running version must ship it. */
export function isHerdrShLiteral(sha256: string): boolean {
  return HERDR_LITERAL_HASHES.has(sha256);
}

/** What Herdr `version` ships for `sha256` (undefined: that version is not listed, or does not ship it). */
export function herdrShLiteral(version: string, sha256: string): ShLiteralKind | undefined {
  const literals = Object.hasOwn(HERDR_SH_LITERALS, version) ? HERDR_SH_LITERALS[version] : undefined;
  return literals !== undefined && Object.hasOwn(literals, sha256) ? literals[sha256] : undefined;
}

/** The `major.minor.patch[-pre]` in a Herdr version string (`0.1.14`, `v0.1.14`, `herdr-app 0.1.14`), or null. */
export function herdrVersionOf(text: string): string | null {
  return /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(text)?.[1] ?? null;
}

/** `$0` the mods pass to each literal. */
export const LISTING_SCRIPT_ARG0 = "files";
export const PICTURE_SCRIPT_ARG0 = "sh";

// ---------------------------------------------------------------------------------------------------------------------
// E4 / E5: git.

/**
 * Subcommands E4 runs (`--version` counts as one). `cat-file`, `rev-list`, `show-ref`, `worktree` and `config` pass
 * only in their read forms (`exec.ts` checks each with the constants below); the rest are read-only as a whole, with
 * {@link GIT_DENIED_ARG} refused before `--`.
 */
export const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "rev-parse",
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "ls-files",
  "for-each-ref",
  "show-ref",
  "cat-file",
  "rev-list",
  "worktree",
  "config",
  "--version",
]);

/** The only `-c` values the shipped `files`/`changes` mods pass. */
export const GIT_CONFIG_VALUES: ReadonlySet<string> = new Set(["core.fsmonitor=false", "diff.autoRefreshIndex=false"]);

/**
 * Long options refused anywhere before `--` (DESIGN-v2 §2.3 E4, plus `--textconv` and `--no-index`: the latter makes
 * `git diff` read any two files on the Mac, around the read roots).
 */
export const GIT_DENIED_LONG_OPTIONS = [
  "--config-env",
  "--exec-path",
  "--upload-pack",
  "--receive-pack",
  "--ext-diff",
  "--textconv",
  "--output",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--no-index",
] as const;

/** Arguments refused anywhere before `--` by their spelling: `-c<k=v>`, `-u…`, and any denied long option and its forms. */
export const GIT_DENIED_ARG = new RegExp(`^(-c(?!$)|-u|${GIT_DENIED_LONG_OPTIONS.join("|")})`);

/** The shortest long-option abbreviation: `--` and one letter. */
const GIT_ABBREV_MIN = 3;

/**
 * Whether a git argument (before `--`) is a denied option: {@link GIT_DENIED_ARG}, or an abbreviation of a denied long
 * option (`--git-d`, `--out=x`, `--no-ind`). Git's parse-options accepts any unambiguous prefix of a long option, so the
 * name up to `=` is refused when it is a prefix of one. Exemptions (`rev-parse --git-dir`, the global `--git-dir` under
 * `gitDirUnderRoots`) match the full spelling only.
 */
export function gitDeniedArg(arg: string): boolean {
  if (GIT_DENIED_ARG.test(arg)) return true;
  if (!arg.startsWith("--")) return false;
  const eq = arg.indexOf("=");
  const name = eq < 0 ? arg : arg.slice(0, eq);
  return name.length >= GIT_ABBREV_MIN && GIT_DENIED_LONG_OPTIONS.some((option) => option.startsWith(name));
}

/** Subcommands that could run a configured external diff or textconv filter; both are switched off for them. */
export const GIT_DIFF_SAFETY: ReadonlySet<string> = new Set(["diff", "show", "log"]);
export const GIT_DIFF_SAFETY_FLAGS = ["--no-ext-diff", "--no-textconv"] as const;

/** `rev-parse` options exempt from {@link gitDeniedArg}: queries that take no value (`--git-dir` prints the dir). */
export const GIT_REV_PARSE_QUERIES: ReadonlySet<string> = new Set(["--git-dir"]);

/** `show-ref` options (the `worktree` mod's branch check: `show-ref --verify --quiet refs/heads/<b>`). */
export const GIT_SHOW_REF_FLAGS: ReadonlySet<string> = new Set(["--verify", "--quiet", "-q"]);

/** `rev-list` only lists local commits on no remote (then at most one revision to exclude too). */
export const GIT_REV_LIST_UNPUSHED = ["-n1", "--all", "--not", "--remotes"] as const;

/** `worktree list` options; `worktree add|remove` are named refusals (Herdr window), every other form is refused. */
export const GIT_WORKTREE_LIST_FLAGS: ReadonlySet<string> = new Set(["--porcelain", "-z", "-v", "--verbose"]);
export const GIT_WORKTREE_CHANGES: ReadonlySet<string> = new Set(["add", "remove"]);

/**
 * `config` only reads, and only a named file or blob (never the user's own config, which can hold credentials):
 * `config (--file <f> | --blob <rev:path>) [-z|--null] --get-regexp <name-re> [<value-re>]`. `--git-dir`, `--file`
 * and `--blob` need the profile's `exec.git.gitDirUnderRoots`; directories and files must be under the read roots.
 */
export const GIT_CONFIG_NULL_FLAGS: ReadonlySet<string> = new Set(["-z", "--null"]);
export const GIT_CONFIG_READ = "--get-regexp";

/**
 * `git branch` lists, creates, renames, deletes and sets upstreams; only listing options are accepted, each by its full
 * spelling (git would take an abbreviation such as `--set-up`; none is on these lists). The mode is decided over the
 * whole argv, `--` included: a name (before or after `--`) is a pattern only with a listing-mode flag
 * ({@link GIT_BRANCH_LISTING_MODE}); otherwise git would create a branch of that name.
 */
export const GIT_BRANCH_LIST_FLAGS: ReadonlySet<string> = new Set([
  "--show-current",
  "--list",
  "-l",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "-i",
  "--ignore-case",
  "--no-color",
  "--no-column",
  "--no-abbrev",
  "--omit-empty",
]);
/** Options with a required value: `--opt=value`, or `--opt` and the next argument (whatever it is, as git takes it). */
export const GIT_BRANCH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--format",
  "--sort",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
]);
/** Options with an optional value: only `--opt=value` sets it; the next argument is never theirs (`--color name`). */
export const GIT_BRANCH_OPTIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set(["--color", "--abbrev"]);
/** Flags that put `git branch` in listing mode, so its names are patterns (builtin/branch.c). */
export const GIT_BRANCH_LISTING_MODE: ReadonlySet<string> = new Set([
  "--list",
  "-l",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
]);

// ---------------------------------------------------------------------------------------------------------------------
// E6 / E7: hc read-only forms.

export const HC_MACHINE_LS = ["machine", "ls", "--json"] as const;
const HC_MACHINE_LS_KEY = HC_MACHINE_LS.join("\0");
export const HC_READ_FORMS: readonly (readonly string[])[] = [
  ["ls", "--json"],
  ["terminal", "list", "--json"],
  ["schema"],
  ["--version"],
];
/** `hc terminal get <id> --json`: an id is printable ASCII without spaces and does not start with `-`. */
export const HC_TERMINAL_ID = /^[!-,.-~][!-~]*$/;
/** `hc machine <these> …` change Herdr's machines: named refusals (Herdr window), with a toast. */
export const HC_MACHINE_CHANGES: ReadonlySet<string> = new Set(["add", "rm"]);

// ---------------------------------------------------------------------------------------------------------------------
// E10: `env K=V… <bin> hub start`.

/** Keys every cockpit launch may set (values checked against cockpit.json / appHome / "app"). */
export const COCKPIT_ENV_KEYS: ReadonlySet<string> = new Set(["HOME", "HERDR_APP_HOME", "COCKPIT_FRONTEND"]);
/** Keys refused even when cockpit.json's `env` lists them. */
export const ENV_FORBIDDEN_KEY = /^(DYLD_|LD_)|^(NODE_OPTIONS|PATH)$/;
/** `env` assignment syntax. */
export const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
export const COCKPIT_ARGS = ["hub", "start"] as const;

// ---------------------------------------------------------------------------------------------------------------------
// E11–E13: opening things on this computer (which programs open URLs, and which are another platform's: the
// platform's `openers`, `../platform.ts`).

/** Editor commands (`editor.js` APPS and its default). */
export const EDITOR_COMMANDS: ReadonlySet<string> = new Set([
  "code",
  "code-insiders",
  "cursor",
  "zed",
  "windsurf",
  "subl",
]);
export const OPEN_URL = /^https?:\/\//i;

// ---------------------------------------------------------------------------------------------------------------------
// Classification: which row describes a request (syntax only; `exec.ts` decides with paths and scope).

/** A request with any `env K=V…` prefix split off. */
export interface ExecShape {
  /** The row whose checks apply; E1/E2 become E3 in `exec.ts` when the script is not a known one. */
  rule: ExecRule;
  /** The program as given (after `env`). */
  program: string;
  /** Its last path component. */
  name: string;
  args: string[];
  /** `env` assignments, in order. */
  env: [string, string][];
  viaEnv: boolean;
  /** E15: which literal variant. */
  picture?: "remote" | "local";
  /** E14/E15: sha256 of the `sh -c` literal. */
  literal?: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Index of the git subcommand after the global options `-C <dir>`, `-c <k=v>`, `--git-dir <dir>` and flags; -1 when
 * none.
 */
export function gitSubcommandIndex(args: readonly string[]): number {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "-C" || a === "-c" || a === "--git-dir") i += 2;
    else if (a.startsWith("-") && !GIT_READ_SUBCOMMANDS.has(a)) i += 1;
    else return i;
  }
  return -1;
}

/** Splits `env [K=V…] program args…`; `null` when `env` is used with an option or without a program. */
function splitEnv(args: readonly string[]): { env: [string, string][]; rest: string[] } | null {
  const env: [string, string][] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const m = ENV_ASSIGNMENT.exec(args[i]);
    if (!m) break;
    env.push([m[1], m[2]]);
  }
  if (i >= args.length || args[i].startsWith("-")) return null;
  return { env, rest: args.slice(i) };
}

/** What classification takes from the requesting folder's profile. */
export interface ClassifyRules {
  /** sha256 of an `sh -c` literal → its native replacement (E14/E15); any other literal is E16. */
  shLiterals: Readonly<Record<string, ShLiteralKind>>;
  /** The runner a `node <script>` is mapped to (the script as the mod names it); otherwise its file name decides. */
  scriptRunner?: (script: string) => ScriptRunner | undefined;
}

/** Classification without a profile: the known literals, scripts by file name. */
export const NO_PROFILE_RULES: ClassifyRules = { shLiterals: KNOWN_SH_LITERALS };

/**
 * The row describing `exec(command, argv)` (`method: "hc"` for `herdr.hc(argv)`) on `platform` (its openers decide
 * E11/E12).
 */
export async function classifyExec(
  method: "exec" | "hc",
  command: string,
  argv: readonly string[],
  rules: ClassifyRules = NO_PROFILE_RULES,
  platform: Platform = hostPlatform(),
): Promise<ExecShape> {
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  if (method === "hc") {
    const rule = argv.join("\0") === HC_MACHINE_LS_KEY ? "E6" : "E7";
    return { rule, program: "hc", name: "hc", args: [...argv], env: [], viaEnv: false };
  }
  let program = command;
  let args = [...argv];
  let env: [string, string][] = [];
  let viaEnv = false;
  const shape = (rule: ExecRule, extra: Partial<ExecShape> = {}): ExecShape => ({
    rule,
    program,
    name: base(program),
    args,
    env,
    viaEnv,
    ...extra,
  });
  if (base(command) === "env") {
    const split = splitEnv(argv);
    if (split === null) return shape("E16");
    [program, ...args] = split.rest;
    env = split.env;
    viaEnv = true;
    if (base(program) === "herdr-app") return shape("E8");
    return shape(env.length ? "E10" : "E16");
  }
  const name = base(program);
  if (name === "herdr-app") return shape("E8");
  // Mods name programs as Herdr resolves them, through PATH; a path is honoured only for cockpit.json's `bin`.
  if (program.includes("/")) return shape(name === "cockpit" ? "E10" : "E16");
  switch (name) {
    case "node": {
      const script = args[0];
      if (script === undefined || script.startsWith("-")) return shape("E3");
      const runner = rules.scriptRunner?.(script);
      if (runner !== undefined) return shape(runner === "sync" ? "E2" : "E1");
      return shape(base(script) === "sync.mjs" ? "E2" : base(script) === "lh-scan.mjs" ? "E1" : "E3");
    }
    case "git": {
      const sub = args[gitSubcommandIndex(args)];
      return shape(sub === "add" || sub === "commit" ? "E5" : "E4");
    }
    case "hc":
      return shape(args.join("\0") === HC_MACHINE_LS_KEY ? "E6" : "E7");
    case "cockpit":
      return shape("E10");
    case "sh": {
      if (args[0] !== "-c" || typeof args[1] !== "string") return shape("E16");
      const literal = await sha256Hex(args[1]);
      const kind = Object.hasOwn(rules.shLiterals, literal) ? rules.shLiterals[literal] : undefined;
      if (kind === "listing") return shape("E14", { literal });
      if (kind === "picture-remote" || kind === "picture-local") {
        return shape("E15", { picture: kind === "picture-remote" ? "remote" : "local", literal });
      }
      return shape("E16");
    }
  }
  if (platform.openers.device.includes(name)) return shape(args[0] === "-a" ? "E13" : "E11");
  if (platform.openers.foreign.includes(name)) return shape("E12");
  if (EDITOR_COMMANDS.has(name)) return shape("E13");
  return shape("E16");
}
