/**
 * The exec policy (DESIGN-v2 §2.3): `herdr.exec(command, argv, {cwd, on, timeout})` and `herdr.hc(argv)` RPCs, and
 * the bridge's own `herdr-app do` pass-through (E9) and `herdr-app --version` probe. Deny by default; each request is
 * classified to one row of `EXEC_TABLE`, checked against the requesting folder's policy profile (OSS-PLAN §1: which
 * rows, scripts and `sh -c` literals it enables, its read roots; Herdr's own literals also against the running Herdr
 * version), checked at argument level, logged, and then run as a plan: an allowlisted program, the native E14
 * listing, a scoped `deno run`, or (E11) a URL handed back to the originating device. Changes only the Herdr window
 * makes (`git worktree add|remove`, `hc machine add|rm`) are named refusals that also toast the device.
 * Migrated from the Deno spike's `policyExec` (`docs/spikes/deno.md`).
 */

import { dirname, join, normalize, resolve } from "@std/path";
import {
  DEFAULT_PROFILE_ID,
  EXEC_RULES,
  type JsonObject,
  type PolicyProfile,
  type Scope,
  type ScriptRunner,
} from "@herdr-relay/protocol";
import { type ExecResult, logDecision, type PolicyLog, PolicyRefusal, refuse, refusedResult } from "./decision.ts";
import { hostPlatform, type Platform } from "../platform.ts";
import {
  classifyExec,
  type ClassifyRules,
  COCKPIT_ARGS,
  COCKPIT_ENV_KEYS,
  ENV_FORBIDDEN_KEY,
  type ExecRule,
  type ExecShape,
  GIT_BRANCH_LIST_FLAGS,
  GIT_BRANCH_LISTING_MODE,
  GIT_BRANCH_OPTIONAL_VALUE_FLAGS,
  GIT_BRANCH_VALUE_FLAGS,
  GIT_CONFIG_NULL_FLAGS,
  GIT_CONFIG_READ,
  GIT_CONFIG_VALUES,
  GIT_DIFF_SAFETY,
  GIT_DIFF_SAFETY_FLAGS,
  GIT_READ_SUBCOMMANDS,
  GIT_REV_LIST_COUNTS,
  GIT_REV_LIST_UNPUSHED,
  GIT_REV_PARSE_QUERIES,
  GIT_SHOW_REF_FLAGS,
  GIT_SYMBOLIC_REF_FLAGS,
  GIT_WORKTREE_CHANGES,
  GIT_WORKTREE_LIST_FLAGS,
  gitDeniedArg,
  gitSubcommandIndex,
  HC_MACHINE_CHANGES,
  HC_READ_FORMS,
  HC_TERMINAL_ID,
  HERDR_SH_LITERALS,
  herdrShLiteral,
  herdrVersionOf,
  isHerdrShLiteral,
  LISTING_SCRIPT_ARG0,
  NO_PROFILE_RULES,
  OPEN_URL,
  PICTURE_SCRIPT_ARG0,
} from "./exec.table.ts";
import { listDirectory } from "./listing.ts";
import { lexical, realPathOrNull, relativeInside, resolveReal, within } from "./paths.ts";
import type { FolderPolicies, FolderPolicy } from "./profiles.ts";
import { type CockpitInstall, type ReadRoots, resolveDirUnderRoots, resolveUnderRoots } from "./read.ts";
import {
  KNOWN_SCRIPTS,
  LH_SCAN_MAX_ARGS,
  LH_SCAN_SUBCOMMANDS,
  lhScanRun,
  pictureDir,
  pictureRun,
  type RunnerPaths,
  runScoped,
  type ScopedRun,
  SCRIPT_TIMEOUT_MS,
  SYNC_OPTIONS,
  syncRun,
} from "./scripts.ts";
import { EXEC_DEFAULT_TIMEOUT_MS, execTimeout, runCapped, type SpawnSpec } from "./spawn.ts";
import { USER_DECISIONS, type UserDecisions } from "./user-decisions.ts";

/** What the exec policy decides with; the bridge refreshes `loadedFolders`, `cockpit` and the profiles' roots. */
export interface PolicyContext {
  /** `appHome` (configured; `appHomeReal`) for every request, and the read roots when no profile is applied. */
  roots: ReadRoots;
  /** Real paths for scoped runners (`paths.appHome` is the real appHome). */
  paths: RunnerPaths;
  /** Mod folders with a running (or starting) host; known scripts must live in one of them. */
  loadedFolders: ReadonlySet<string>;
  /** `<appHome>/cockpit.json` as the bridge read it, or null. */
  cockpit: CockpitInstall | null;
  /** The bridge's own `PATH` (and `TMPDIR`), for `git` reads and `hc`, which run with a cleared environment. */
  env: { PATH: string; TMPDIR?: string };
  log: PolicyLog;
  /** U1–U3; defaults to `USER_DECISIONS` (pending user confirmation). */
  decisions?: UserDecisions;
  /**
   * The running Herdr's version (the mirror's `updates().app.version`, else the bridge's `herdr-app --version` at
   * start); null or absent while unknown. Under a profile, a pin of one of Herdr's own `sh -c` literals (E14) holds
   * only while this is a version that ships it (`HERDR_SH_LITERALS`).
   */
  herdrVersion?: string | null;
  /** Which programs open things on this computer (E11) and which are another platform's (E12); default the host's. */
  platform?: Platform;
  /**
   * The requesting folder's profile and read roots (OSS-PLAN §1): only its enabled rows, scripts and `sh -c` literals
   * pass, within its roots; the `default` profile refuses every exec and hc. Set by {@link policyContext}, the only
   * way the bridge builds a context. Absent (a test of the rows themselves, warned once): every row with the known
   * scripts and literals, `roots` as the read roots, no Herdr version check and no `--git-dir`. E9 (`run()`
   * pass-through, no folder) is never profile-gated.
   */
  profileFor?(folder: string): Promise<FolderPolicy>;
}

/** The bridge's policy context: `base` deciding through `policies` (every folder gets its profile, or `default`). */
export function policyContext(base: Omit<PolicyContext, "profileFor">, policies: FolderPolicies): PolicyContext {
  return { ...base, profileFor: (folder) => policies.policyFor(folder) };
}

/** Whether `ctx` applies policy profiles (every context the bridge builds does; see {@link policyContext}). */
export function appliesProfiles(ctx: PolicyContext): boolean {
  return ctx.profileFor !== undefined;
}

let warnedWithoutProfiles = false;

/** The folder's profile and roots, or null for a context without profiles (warned once per process). */
async function folderPolicy(ctx: PolicyContext, folder: string): Promise<FolderPolicy | null> {
  if (ctx.profileFor !== undefined) return await ctx.profileFor(folder);
  if (!warnedWithoutProfiles) {
    warnedWithoutProfiles = true;
    console.warn("herdr-relay policy: policy context without profiles (tests only): every row decides alone");
  }
  return null;
}

export interface ExecOptions {
  cwd?: string | null;
  on?: string | null;
  timeout?: number | null;
}

/** One `exec`/`hc` RPC, attributed to the folder of the connection it arrived on. */
export interface ExecRequest {
  folder: string;
  method: "exec" | "hc";
  /** `exec`'s program; ignored for `hc`. */
  command: string;
  argv: readonly string[];
  options?: ExecOptions;
  /**
   * The device session the view manager resolved from the host's origin token (`views/origins.ts`): addresses the
   * device; E2/E5 also need one (a connected act device). A downgraded origin keeps the presented token here.
   */
  session?: string | null;
  /** That session's scope in the bridge's own table; `read` for a downgraded origin (forged, expired, foreign token). */
  scope: Scope;
}

export type ExecPlan =
  /** `toast`: a named refusal (a change only the Herdr window makes) that the originating device also sees. */
  | { kind: "refuse"; rule: ExecRule; reason: string; toast?: string }
  | { kind: "open-url"; rule: "E11"; url: string }
  | { kind: "spawn"; rule: ExecRule; spec: SpawnSpec }
  | { kind: "listing"; rule: "E14"; dir: string | null }
  | { kind: "script"; rule: "E1" | "E15"; run: ScopedRun; timeoutMs: number }
  | { kind: "sync"; rule: "E2"; run: ScopedRun; timeoutMs: number };

export interface ExecOutcome {
  rule: ExecRule;
  decision: "allow" | "refuse" | "intercept";
  result: ExecResult;
  /** E11: open this URL on the originating device (`toast.action.open`); nothing ran on the Mac. */
  openUrl?: string;
  /** A named refusal: toast this on the originating device (the mod gets the refusal as its result too). */
  toast?: string;
}

/** Decides a request; never throws for policy reasons (refusals are a plan). */
export async function decideExec(ctx: PolicyContext, req: ExecRequest): Promise<ExecPlan> {
  return await decideWith(ctx, req, await folderPolicy(ctx, req.folder));
}

async function decideWith(ctx: PolicyContext, req: ExecRequest, policy: FolderPolicy | null): Promise<ExecPlan> {
  const rules = policy === null ? NO_PROFILE_RULES : profileRules(ctx, policy.profile);
  const shape = await classifyExec(req.method, req.command, req.argv, rules, ctx.platform ?? hostPlatform());
  try {
    return await decide(ctx, req, shape, policy);
  } catch (e) {
    if (!(e instanceof PolicyRefusal)) throw e;
    // A check may name another row (an unknown script is E3); path checks (rule `read`) count for the request's row.
    const rule = EXEC_RULES.find((r) => r === e.rule) ?? shape.rule;
    return { kind: "refuse", rule, reason: e.message };
  }
}

/** Classification by a profile: its literals; a script it maps (by the path the mod gives, under appHome) runs as such. */
function profileRules(ctx: PolicyContext, profile: PolicyProfile): ClassifyRules {
  const scripts = profile.scripts ?? {};
  return {
    shLiterals: profile.shLiterals ?? {},
    scriptRunner: (script) => {
      const abs = lexical(script, ctx.roots.appHome);
      const rel = relativeInside(abs, ctx.roots.appHome) ?? relativeInside(abs, ctx.paths.appHome);
      return rel !== null && Object.hasOwn(scripts, rel) ? scripts[rel] : undefined;
    },
  };
}

async function decide(
  ctx: PolicyContext,
  req: ExecRequest,
  shape: ExecShape,
  policy: FolderPolicy | null,
): Promise<ExecPlan> {
  const decisions = ctx.decisions ?? USER_DECISIONS;
  const r = shape.rule;
  const { args } = shape;
  const opts = req.options ?? {};
  const profile = policy?.profile ?? null;
  const roots = policy?.roots ?? ctx.roots;
  if (profile?.id === DEFAULT_PROFILE_ID) refuse(r, `no profile for ${req.folder}: exec and hc are off`);
  // Rows refused whatever their arguments.
  const outright: Partial<Record<ExecRule, string>> = {
    E3: "node runs only the known lstack scripts, without flags",
    E8: "needs the Herdr window (structural change)",
    E12: `${shape.name} does not exist on ${(ctx.platform ?? hostPlatform()).label}`,
    E13: "opens an app on the Mac; not available remotely",
    E16: `${shape.viaEnv ? "env" : shape.program} is not on the exec allowlist`,
  };
  if (outright[r] !== undefined) refuse(r, outright[r]);
  if (profile !== null && !(profile.exec?.rows ?? []).some((row) => row === r)) {
    refuse(r, `${r} is not enabled for ${req.folder} (profile ${profile.id})`);
  }
  const structural = structuralChange(shape);
  if (structural !== null) return { kind: "refuse", rule: r, ...structural };
  if (opts.on !== undefined && opts.on !== null && opts.on !== "") refuse(r, "remote machines are out of scope");
  if (profile !== null) checkHerdrLiteral(ctx, shape);
  const cwd = typeof opts.cwd === "string" && opts.cwd !== ""
    ? await resolveDirUnderRoots(roots, opts.cwd, "cwd")
    : null;
  const timeoutMs = execTimeout(opts.timeout);
  const scripts: Readonly<Record<string, ScriptRunner>> = profile === null ? KNOWN_SCRIPTS : profile.scripts ?? {};

  switch (r) {
    case "E1": {
      const script = await knownScript(ctx, scripts, args[0], "lh-scan");
      const rest = args.slice(1);
      if (!LH_SCAN_SUBCOMMANDS.has(rest[0] ?? "")) refuse(r, `lh-scan ${rest[0] ?? ""}: unknown subcommand`);
      if (rest.length - 1 > LH_SCAN_MAX_ARGS) refuse(r, `lh-scan takes at most ${LH_SCAN_MAX_ARGS} arguments`);
      if (rest.some((a) => a.startsWith("-"))) refuse(r, "lh-scan arguments may not start with -");
      const run = lhScanRun(ctx.paths, script, rest);
      return { kind: "script", rule: r, run, timeoutMs: Math.min(timeoutMs, SCRIPT_TIMEOUT_MS["lh-scan"]) };
    }
    case "E2": {
      if (!decisions.syncFromDevices) {
        refuse(r, "Run Sync on the Mac: regenerating the lstack fork from a device is off");
      }
      if (req.scope !== "act" || !req.session) refuse(r, "Run Sync needs a connected device with act scope");
      const script = await knownScript(ctx, scripts, args[0], "sync");
      const rest = args.slice(1);
      if (rest.some((a) => !SYNC_OPTIONS.has(a))) refuse(r, "sync.mjs takes only --json and --check");
      return { kind: "sync", rule: r, run: syncRun(ctx.paths, script, rest), timeoutMs };
    }
    case "E4":
      return await decideGitRead(ctx, roots, args, cwd, timeoutMs, profile?.exec?.git?.gitDirUnderRoots === true);
    case "E5": {
      if (!decisions.gitCommitFromActDevices) refuse(r, "committing from a device is off");
      if (req.scope !== "act" || !req.session) refuse(r, "committing needs a connected device with act scope");
      const add = args.length === 2 && args[0] === "add" && args[1] === "-A";
      const commit = args.length === 3 && args[0] === "commit" && args[1] === "-m" && args[2].trim() !== "";
      if (!add && !commit) refuse(r, "only `git add -A` and `git commit -m <message>` are allowed");
      if (cwd === null) refuse(r, "git add/commit needs the repository root as cwd");
      if (!(await Deno.lstat(join(cwd, ".git")).catch(() => null))) refuse(r, "cwd is not a repository root");
      // Cleared environment like the reads: the user's git config still applies (HOME); agent sockets do not reach it.
      const env: Record<string, string> = { HOME: ctx.paths.home, PATH: ctx.env.PATH, GIT_TERMINAL_PROMPT: "0" };
      if (ctx.env.TMPDIR) env.TMPDIR = ctx.env.TMPDIR;
      return { kind: "spawn", rule: r, spec: { command: "git", args: [...args], cwd, env, clearEnv: true, timeoutMs } };
    }
    case "E6":
    case "E7": {
      const terminalGet = args.length === 4 && args[0] === "terminal" && args[1] === "get" &&
        HC_TERMINAL_ID.test(args[2]) && args[3] === "--json";
      if (r === "E7" && !terminalGet && !HC_READ_FORMS.some((f) => f.join("\0") === args.join("\0"))) {
        refuse(r, `hc ${args.join(" ")} is not a read-only form`);
      }
      // Only HOME and PATH, as core's hcConnectEnv() gives `hc connect`: no HC_* (HC_SOCKET, HC_TERMINAL_ID, …) from a
      // bridge started inside a Herdr terminal. Values come from the context, so deciding reads no environment.
      const env = { HOME: ctx.paths.home, PATH: ctx.env.PATH };
      const spec = { command: "hc", args: [...args], cwd: cwd ?? undefined, env, clearEnv: true, timeoutMs };
      return { kind: "spawn", rule: r, spec };
    }
    case "E10":
      return await decideCockpit(ctx, shape, cwd, timeoutMs);
    case "E11": {
      if (!decisions.openUrlOnDevice) refuse(r, "opening links from mods is off");
      let url: URL | null = null;
      try {
        url = args.length === 1 && OPEN_URL.test(args[0]) ? new URL(args[0]) : null;
      } catch {
        url = null;
      }
      if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
        refuse(r, `${shape.name} only opens http(s) links, on your device`);
      }
      return { kind: "open-url", rule: r, url: url.href };
    }
    case "E14": {
      if (args.length !== 4 || args[2] !== LISTING_SCRIPT_ARG0) refuse(r, "unexpected arguments to the listing script");
      return { kind: "listing", rule: r, dir: await resolveUnderRoots(roots, args[3], "folder") };
    }
    case "E15":
      return await decidePicture(ctx, roots, shape, timeoutMs);
  }
  return refuse(r, `${shape.name} is not on the exec allowlist`);
}

/** The real path of a script `scripts` maps to `runner`, inside a loaded folder; else a refusal (E3). */
async function knownScript(
  ctx: PolicyContext,
  scripts: Readonly<Record<string, ScriptRunner>>,
  script: string | undefined,
  runner: ScriptRunner,
): Promise<string> {
  if (script === undefined) refuse("E3", "node without a script");
  const real = await realPathOrNull(lexical(script, ctx.roots.appHome)).catch(() => null);
  const rel = real === null ? null : relativeInside(real, ctx.paths.appHome);
  const folder = rel?.split("/")[1];
  if (
    rel === null || !Object.hasOwn(scripts, rel) || scripts[rel] !== runner || folder === undefined ||
    !ctx.loadedFolders.has(folder)
  ) {
    refuse("E3", `${script} is not a known script of a loaded mod folder`);
  }
  return real!;
}

/** A change only the Herdr window makes (`git worktree add|remove`, `hc machine add|rm`): its refusal and toast. */
function structuralChange(shape: ExecShape): { reason: string; toast: string } | null {
  const { args } = shape;
  if (shape.rule === "E4") {
    const i = gitSubcommandIndex(args);
    const change = i < 0 ? undefined : args[i + 1];
    if (args[i] === "worktree" && change !== undefined && GIT_WORKTREE_CHANGES.has(change)) {
      return {
        reason: `git worktree ${change} needs the Herdr window (structural change)`,
        toast: "Worktree changes — use the Herdr window",
      };
    }
  }
  if (shape.rule === "E7" && args[0] === "machine" && HC_MACHINE_CHANGES.has(args[1])) {
    return {
      reason: `hc machine ${args[1]} needs the Herdr window (structural change)`,
      toast: "Machine changes — use the Herdr window",
    };
  }
  return null;
}

/**
 * A profile's pin of one of Herdr's own `sh -c` literals holds only while the running Herdr is a version that ships
 * that literal as that kind (`HERDR_SH_LITERALS`); other pinned literals (a user's, cockpit's) are the profile's alone.
 */
function checkHerdrLiteral(ctx: PolicyContext, shape: ExecShape): void {
  const literal = shape.literal;
  if (literal === undefined || !isHerdrShLiteral(literal)) return;
  const version = ctx.herdrVersion ? herdrVersionOf(ctx.herdrVersion) : null;
  if (version === null) refuse(shape.rule, "the running Herdr version is not known: its sh -c literals stay off");
  if (!Object.hasOwn(HERDR_SH_LITERALS, version)) {
    refuse(shape.rule, `Herdr ${version} is not a version this bridge knows: its sh -c literals stay off`);
  }
  const expected = shape.rule === "E14" ? "listing" : `picture-${shape.picture}`;
  if (herdrShLiteral(version, literal) !== expected) {
    refuse(shape.rule, `this sh -c literal is not one Herdr ${version} ships`);
  }
}

async function decideGitRead(
  ctx: PolicyContext,
  roots: ReadRoots,
  args: readonly string[],
  cwd: string | null,
  timeoutMs: number,
  gitDirUnderRoots: boolean,
): Promise<ExecPlan> {
  const out: string[] = [];
  let dirC: string | null = null;
  let gitDir: string | null = null;
  let i = 0;
  for (; i < args.length && args[i].startsWith("-") && !GIT_READ_SUBCOMMANDS.has(args[i]); i++) {
    const a = args[i];
    if (a === "--no-optional-locks") out.push(a);
    else if (a === "-c") {
      if (!GIT_CONFIG_VALUES.has(args[i + 1])) {
        refuse("E4", "git -c is limited to core.fsmonitor=false and diff.autoRefreshIndex=false");
      }
      out.push(a, args[++i]);
    } else if (a === "-C") {
      if (dirC !== null || args[i + 1] === undefined) refuse("E4", "git takes one -C <folder>");
      dirC = await resolveDirUnderRoots(roots, args[++i], "git -C");
      out.push(a, dirC);
    } else if (a === "--git-dir") {
      if (!gitDirUnderRoots) refuse("E4", "git --git-dir is not enabled for this mod folder");
      if (gitDir !== null || args[i + 1] === undefined) refuse("E4", "git takes one --git-dir <folder>");
      gitDir = await resolveDirUnderRoots(roots, args[++i], "git --git-dir");
      out.push(a, gitDir);
    } else refuse("E4", `git option ${a} is not allowed`);
  }
  const sub = args[i];
  if (sub === undefined || !GIT_READ_SUBCOMMANDS.has(sub)) {
    refuse("E4", `git ${sub ?? ""} is not a read-only subcommand`);
  }
  let rest = args.slice(i + 1);
  const end = rest.indexOf("--");
  const options = end < 0 ? rest : rest.slice(0, end);
  // Exemptions match the full spelling only: `rev-parse --git-d` is an abbreviation git would expand, so it is refused.
  const bad = options.find((a) => gitDeniedArg(a) && !(sub === "rev-parse" && GIT_REV_PARSE_QUERIES.has(a)));
  if (bad !== undefined) refuse("E4", `git option ${bad} is not allowed`);
  // Each subcommand's mode is decided over its whole argv: what follows `--` can change it (`branch -- <name>`).
  switch (sub) {
    case "branch":
      checkBranchListing(rest);
      break;
    case "diff":
      await checkDiffInWorkTree(ctx.paths.home, rest, dirC ?? cwd, gitDir);
      break;
    case "show-ref":
      for (const a of rest) {
        if (a.startsWith("-") && !GIT_SHOW_REF_FLAGS.has(a)) refuse("E4", `git show-ref ${a} is not allowed`);
      }
      break;
    case "cat-file":
      if (rest.length !== 2 || rest[0] !== "-e" || rest[1].startsWith("-")) {
        refuse("E4", "only `git cat-file -e <object>` is allowed");
      }
      break;
    case "symbolic-ref": {
      const names = rest.filter((a) => !GIT_SYMBOLIC_REF_FLAGS.has(a));
      if (names.length !== 1 || names[0].startsWith("-")) {
        refuse("E4", "only `git symbolic-ref [-q] <name>` (reading one symbolic ref) is allowed");
      }
      break;
    }
    case "rev-list": {
      // The unpushed check takes at most one more revision to exclude; the ahead/behind counts exactly one range.
      const unpushed = GIT_REV_LIST_UNPUSHED.every((a, k) => rest[k] === a);
      const counts = GIT_REV_LIST_COUNTS.every((a, k) => rest[k] === a);
      const extra = rest.slice(unpushed ? GIT_REV_LIST_UNPUSHED.length : GIT_REV_LIST_COUNTS.length);
      if (!(unpushed ? extra.length <= 1 : counts && extra.length === 1) || extra.some((a) => a.startsWith("-"))) {
        refuse(
          "E4",
          `only \`git rev-list ${GIT_REV_LIST_UNPUSHED.join(" ")} [<revision>]\` or ` +
            `\`git rev-list ${GIT_REV_LIST_COUNTS.join(" ")} <range>\` is allowed`,
        );
      }
      break;
    }
    case "worktree":
      if (rest[0] !== "list" || !rest.slice(1).every((a) => GIT_WORKTREE_LIST_FLAGS.has(a))) {
        refuse("E4", `git worktree ${rest[0] ?? ""} is not a listing`);
      }
      break;
    case "config":
      rest = await configRead(roots, rest, gitDirUnderRoots);
      break;
  }
  out.push(sub);
  if (GIT_DIFF_SAFETY.has(sub)) { for (const f of GIT_DIFF_SAFETY_FLAGS) if (!options.includes(f)) out.push(f); }
  out.push(...rest);
  if (dirC === null && cwd === null && sub !== "--version") refuse("E4", "git needs a folder (cwd or -C)");
  const env: Record<string, string> = {
    HOME: ctx.paths.home,
    PATH: ctx.env.PATH,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  if (ctx.env.TMPDIR) env.TMPDIR = ctx.env.TMPDIR;
  return {
    kind: "spawn",
    rule: "E4",
    spec: { command: "git", args: out, cwd: cwd ?? dirC ?? ctx.paths.appHome, env, clearEnv: true, timeoutMs },
  };
}

/**
 * `git config` arguments that only read a named file or blob: `(--file <f> | --blob <rev:path>) [-z|--null]
 * --get-regexp <name-re> [<value-re>]`, with the file's real path; both sources need `gitDirUnderRoots`.
 */
async function configRead(roots: ReadRoots, args: readonly string[], gitDirUnderRoots: boolean): Promise<string[]> {
  const out: string[] = [];
  let source: string | null = null;
  let i = 0;
  for (; i < args.length && args[i] !== GIT_CONFIG_READ; i++) {
    const a = args[i];
    if (GIT_CONFIG_NULL_FLAGS.has(a)) {
      out.push(a);
      continue;
    }
    if (a !== "--file" && a !== "--blob") refuse("E4", `git config ${a} is not allowed`);
    if (!gitDirUnderRoots) refuse("E4", `git config ${a} is not enabled for this mod folder`);
    const value = args[i + 1];
    if (source !== null || value === undefined || value === "" || value.startsWith("-")) {
      refuse("E4", "git config reads one --file <path> or --blob <rev:path>");
    }
    i++;
    if (a === "--file") {
      const real = await resolveUnderRoots(roots, value, "git config --file");
      if (real === null || !(await Deno.stat(real)).isFile) refuse("read", `git config --file ${value} is not a file`);
      source = real;
    } else source = value;
    out.push(a, source);
  }
  const patterns = args.slice(i + 1);
  if (source === null) refuse("E4", "git config reads only a named --file or --blob");
  // git parses options after positionals too: a pattern must not be one (`--includes` would follow include.path).
  if (
    args[i] !== GIT_CONFIG_READ || patterns.length < 1 || patterns.length > 2 || patterns.some((a) => a.startsWith("-"))
  ) {
    refuse("E4", `git config only reads, with ${GIT_CONFIG_READ} <name-regex> [<value-regex>]`);
  }
  out.push(GIT_CONFIG_READ, ...patterns);
  return out;
}

/**
 * `git branch` may only list (DESIGN-v2 E4 names it read-only; its create/rename/delete/upstream forms are not). Every
 * option must be a listing option by its full spelling; names, before or after `--`, are allowed only as patterns of
 * an explicit listing mode (`--list`, `-l`, `--contains`, `--merged`, …): otherwise git creates a branch of that name.
 */
function checkBranchListing(args: readonly string[]): void {
  let listing = false;
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      names.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("-")) {
      names.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const flag = eq < 0 ? a : a.slice(0, eq);
    if (GIT_BRANCH_LISTING_MODE.has(flag)) listing = true;
    if (GIT_BRANCH_LIST_FLAGS.has(a) || GIT_BRANCH_OPTIONAL_VALUE_FLAGS.has(flag)) continue;
    if (GIT_BRANCH_VALUE_FLAGS.has(flag)) {
      // Git takes the next argument as the value, whatever it looks like.
      if (eq < 0) i++;
      continue;
    }
    refuse("E4", `git branch ${a} is not a listing option`);
  }
  if (names.length > 0 && !listing) refuse("E4", `git branch ${names[0]}: a name is a pattern only with --list`);
}

/**
 * `git diff` becomes `--no-index` by itself (builtin/diff.c) and then reads any two files: outside a work tree, or when
 * one of two operands is a path outside it. So it runs only inside a work tree git will use — the explicit `--git-dir`,
 * or a `.git` above `dir` on the same filesystem, owned by the owner of `$HOME` (git treats a repository of another
 * owner as no repository) — and with no operand that is absolute or has a `..` segment (git compares a relative path
 * lexically, so one without `..` is inside the work tree). Option values given as separate arguments count as operands.
 */
async function checkDiffInWorkTree(
  home: string,
  args: readonly string[],
  dir: string | null,
  gitDir: string | null,
): Promise<void> {
  const end = args.indexOf("--");
  const operands = [
    ...(end < 0 ? args : args.slice(0, end)).filter((a) => !a.startsWith("-")),
    ...(end < 0 ? [] : args.slice(end + 1)),
  ];
  const outside = operands.find((a) => a.startsWith("/") || a.split("/").includes(".."));
  if (outside !== undefined) {
    refuse("E4", `git diff ${outside}: paths must be inside the repository, relative, without ..`);
  }
  if (gitDir !== null) return;
  const owner = (await Deno.stat(home).catch(() => null))?.uid ?? null;
  if (dir === null || !(await inOwnWorkTree(dir, owner))) refuse("E4", "git diff runs only inside a repository");
}

/** Whether git finds a work tree for `start` the way it searches (up to a filesystem boundary), owned by `owner`. */
async function inOwnWorkTree(start: string, owner: number | null): Promise<boolean> {
  const owned = (st: Deno.FileInfo) => owner === null || st.uid === null || st.uid === owner;
  const first = await Deno.stat(start).catch(() => null);
  if (first === null) return false;
  for (let dir = start;; dir = dirname(dir)) {
    // Outside the bridge's own read permission (above `$HOME`) counts as not found.
    const st = await Deno.stat(dir).catch(() => null);
    if (st === null || st.dev !== first.dev) return false;
    const dotGit = await Deno.stat(join(dir, ".git")).catch(() => null);
    if (dotGit?.isDirectory) return owned(st) && owned(dotGit);
    if (dotGit?.isFile) {
      // A gitfile (`gitdir: <path>`, linked worktrees and submodules): its git directory must be owned too.
      const target = /^gitdir: (.+)$/m.exec(await Deno.readTextFile(join(dir, ".git")).catch(() => ""))?.[1];
      const gd = target === undefined ? null : await Deno.stat(resolve(dir, target)).catch(() => null);
      return gd !== null && gd.isDirectory && owned(st) && owned(dotGit) && owned(gd);
    }
    if (dirname(dir) === dir) return false;
  }
}

async function samePath(a: string, b: string): Promise<boolean> {
  if (normalize(a) === normalize(b)) return true;
  const [ra, rb] = await Promise.all([realPathOrNull(a).catch(() => null), realPathOrNull(b).catch(() => null)]);
  return ra !== null && ra === rb;
}

async function decideCockpit(
  ctx: PolicyContext,
  shape: ExecShape,
  cwd: string | null,
  timeoutMs: number,
): Promise<ExecPlan> {
  const install = ctx.cockpit;
  for (const [k] of shape.env) {
    if (ENV_FORBIDDEN_KEY.test(k)) refuse("E10", `env var ${k} is never passed`);
  }
  if (install === null || typeof install.bin !== "string") refuse("E10", "cockpit is not installed (no cockpit.json)");
  const bin = install.bin;
  if (!(await samePath(shape.program, bin))) refuse("E10", `${shape.program} is not cockpit.json's bin`);
  // Cleared environment: exactly the checked assignments, plus the bridge's PATH (PATH is never a mod's to set). No
  // prototype: an assignment's key is the mod's string.
  const env: Record<string, string> = Object.assign(Object.create(null), { PATH: ctx.env.PATH });
  for (const [k, v] of shape.env) {
    const ok = COCKPIT_ENV_KEYS.has(k)
      ? (k === "HOME" && v === (install.home ?? ctx.paths.home)) ||
        (k === "HERDR_APP_HOME" && (v === ctx.roots.appHome || v === ctx.paths.appHome)) ||
        (k === "COCKPIT_FRONTEND" && v === "app")
      : Object.hasOwn(install.env ?? {}, k) && install.env![k] === v;
    if (!ok) {
      refuse(
        "E10",
        COCKPIT_ENV_KEYS.has(k) || Object.hasOwn(install.env ?? {}, k)
          ? `env var ${k} does not match cockpit.json`
          : `env var ${k} is not on the exec env allowlist`,
      );
    }
    env[k] = v;
  }
  if (shape.args.join("\0") !== COCKPIT_ARGS.join("\0")) refuse("E10", "only `cockpit hub start` is allowed");
  return {
    kind: "spawn",
    rule: "E10",
    spec: { command: bin, args: [...COCKPIT_ARGS], cwd: cwd ?? undefined, env, clearEnv: true, timeoutMs },
  };
}

async function decidePicture(
  ctx: PolicyContext,
  roots: ReadRoots,
  shape: ExecShape,
  timeoutMs: number,
): Promise<ExecPlan> {
  const { args } = shape;
  if (args.length !== 5 || args[2] !== PICTURE_SCRIPT_ARG0) refuse("E15", "unexpected arguments to the picture script");
  const [, , , destArg, srcArg] = args;
  const dir = (await resolveReal(pictureDir(ctx.paths.appHome))).real;
  const lexicalDest = lexical(destArg, ctx.roots.appHome);
  const lexicalDirs = [pictureDir(ctx.roots.appHome), pictureDir(ctx.paths.appHome)];
  if (!lexicalDirs.some((d) => within(lexicalDest, d) && lexicalDest !== d)) {
    refuse("E15", "the picture must go to data/cockpit/show");
  }
  const dest = await resolveReal(lexicalDest);
  if (!within(dest.real, dir) || dest.real === dir) {
    refuse("E15", "the picture destination resolves outside data/cockpit/show");
  }
  if (dest.exists && !(await Deno.stat(dest.real)).isFile) refuse("E15", "the picture destination is not a file");
  const timeout = Math.min(timeoutMs, SCRIPT_TIMEOUT_MS.picture);
  if (shape.picture === "remote") {
    let url: URL | null = null;
    try {
      url = new URL(srcArg);
    } catch {
      url = null;
    }
    if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
      refuse("E15", "a remote picture must be an http(s) URL");
    }
    return {
      kind: "script",
      rule: "E15",
      run: pictureRun(ctx.paths, { variant: "remote", dest: dest.real, url }),
      timeoutMs: timeout,
    };
  }
  const src = await resolveUnderRoots(roots, srcArg, "picture");
  if (src === null || !(await Deno.stat(src)).isFile) refuse("E15", "the picture file does not exist");
  return {
    kind: "script",
    rule: "E15",
    run: pictureRun(ctx.paths, { variant: "local", dest: dest.real, src }),
    timeoutMs: timeout,
  };
}

/** Runs a decided plan. Refusals resolve with code 126; a program that cannot start throws (Herdr rejects then). */
export async function runPlan(plan: ExecPlan): Promise<ExecResult> {
  switch (plan.kind) {
    case "refuse":
      return refusedResult(plan.reason);
    case "open-url":
      return { code: 0, stdout: "", stderr: "" };
    case "spawn":
      return await runCapped(plan.spec);
    case "listing":
      return await listDirectory(plan.dir);
    case "script":
      return await runScoped(plan.run, plan.timeoutMs);
    case "sync": {
      // `--check` first: exit 0 = nothing to change (that answer is the result), 2 = changes pending, 1 = failure.
      const check = await runScoped({ ...plan.run, args: [...new Set([...plan.run.args, "--check"])] }, plan.timeoutMs);
      if (check.code !== 2 || plan.run.args.includes("--check")) return check;
      return await runScoped(plan.run, plan.timeoutMs);
    }
  }
}

/**
 * Decides, logs (with the folder's profile id) and runs one `exec`/`hc` RPC. `decideExec` is argument-level only;
 * here a program given by absolute path (E10's cockpit.json `bin`) must also be exactly the one the bridge's
 * `--allow-run` resolved (`cockpit` on PATH), or the request is refused before anything is logged as allowed.
 */
export async function policyExec(ctx: PolicyContext, req: ExecRequest): Promise<ExecOutcome> {
  const policy = await folderPolicy(ctx, req.folder);
  let plan = await decideWith(ctx, req, policy);
  if (
    plan.kind === "spawn" && plan.spec.command.includes("/") &&
    (await Deno.permissions.query({ name: "run", command: plan.spec.command })).state !== "granted"
  ) {
    plan = { kind: "refuse", rule: plan.rule, reason: `${plan.spec.command} is not the program the bridge may run` };
  }
  const decision = plan.kind === "refuse" ? "refuse" : plan.kind === "open-url" ? "intercept" : "allow";
  logDecision(ctx.log, {
    folder: req.folder,
    method: req.method,
    argv: req.method === "hc" ? ["hc", ...req.argv] : [req.command, ...req.argv],
    decision,
    rule: plan.rule,
    reason: plan.kind === "refuse" ? plan.reason : undefined,
    session: req.session ?? undefined,
    profile: policy?.profile.id,
  });
  const result = await runPlan(plan);
  if (plan.kind === "open-url") return { rule: plan.rule, decision, result, openUrl: plan.url };
  if (plan.kind === "refuse" && plan.toast !== undefined) {
    return { rule: plan.rule, decision, result, toast: plan.toast };
  }
  return { rule: plan.rule, decision, result };
}

// ---------------------------------------------------------------------------------------------------------------------
// E9: the bridge's `run()` pass-through (`herdr-app do <name> <json>`), not a mod exec.

/** `run()` command classes (DESIGN-v2 §2.4; the classification itself is `commands.json`, owned by session code). */
export type RunCommandClass = "session" | "mod" | "structural" | "passthrough" | "unknown";

export interface HerdrAppDoRequest {
  /** The folder whose copy called `run()`, or null for a device's own command. */
  folder: string | null;
  name: string;
  args?: JsonObject;
  commandClass: RunCommandClass;
  scope: Scope;
  session?: string | null;
}

const COMMAND_NAME = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

/** E9: allowed only for `passthrough` names from an `act`-scope session. */
export function decideHerdrAppDo(ctx: PolicyContext, req: HerdrAppDoRequest): ExecPlan {
  if (req.commandClass !== "passthrough") {
    return { kind: "refuse", rule: "E9", reason: `${req.name} is not a pass-through command` };
  }
  if (req.scope !== "act") return { kind: "refuse", rule: "E9", reason: `${req.name} needs a device with act scope` };
  if (!COMMAND_NAME.test(req.name)) return { kind: "refuse", rule: "E9", reason: "not a command name" };
  return {
    kind: "spawn",
    rule: "E9",
    spec: {
      command: "herdr-app",
      args: ["do", req.name, JSON.stringify(req.args ?? {})],
      env: { HOME: ctx.paths.home, PATH: ctx.env.PATH, HERDR_APP_HOME: ctx.roots.appHome },
      clearEnv: true,
      timeoutMs: EXEC_DEFAULT_TIMEOUT_MS,
    },
  };
}

/** Decides, logs (method `run`) and runs one pass-through command. Not profile-gated; a folder's profile is logged. */
export async function policyHerdrAppDo(ctx: PolicyContext, req: HerdrAppDoRequest): Promise<ExecOutcome> {
  const plan = decideHerdrAppDo(ctx, req);
  const decision = plan.kind === "refuse" ? "refuse" : "allow";
  const policy = req.folder === null ? null : await folderPolicy(ctx, req.folder);
  logDecision(ctx.log, {
    folder: req.folder,
    method: "run",
    argv: ["herdr-app", "do", req.name, JSON.stringify(req.args ?? {})],
    decision,
    rule: "E9",
    reason: plan.kind === "refuse" ? plan.reason : undefined,
    session: req.session ?? undefined,
    profile: policy?.profile.id,
  });
  return { rule: "E9", decision, result: await runPlan(plan) };
}
