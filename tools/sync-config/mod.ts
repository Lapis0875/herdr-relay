/**
 * `sync-config` (DESIGN-v2 T13, D9; docs/DESKTOP.md): the Mac → PC part of the desktop path. Plans which files of a
 * Herdr app home another machine needs to show the same personal layouts, and with `--apply` copies them into a
 * local folder, or sends them to `[user@]host:path` with rsync over SSH and merges the target's keys.json (rsync runs
 * only; {@link remoteSteps}). It never writes the source and writes nothing without `--apply`: a dry run prints the
 * plan and, for a remote target, the exact rsync lines `--apply` runs.
 *
 * What is synced (docs/DESKTOP.md "What sync-config copies"; DESIGN §2 generalised):
 * - every user layout: `layouts/<L>.json` whose `layout:<L>` is not shipped, plus the preview its root names;
 * - the mods those layouts reference (`mod`, a string `header`, `terminal_menu`; never inside `props`) that are not
 *   shipped, with the other folders of the built-in policy profile governing such a mod (a generated fork brings its
 *   source), minus the files Herdr writes into mod folders itself ({@link APP_WRITTEN});
 * - the themes those layouts name, unless byte-identical to the shipped default;
 * - the `keys.json` sections `layout:<L>` and `mod:<M>` of what is synced, merged section by section (the target's
 *   other sections stay).
 * Shipped mods and layouts are the pinned contract's (`packages/bridge/src/compat/pins.json`) plus the source's own
 * `installed.json`; shipped themes and `programs.json` are the pinned generic home's (`fixtures/generic-home/
 * MANIFEST.json`). Themes, `programs.json` and `my-icons/` files that differ from those defaults are listed for review
 * and copied only when named with `--include`.
 *
 *   deno run --allow-read --allow-env=HOME,HERDR_APP_HOME,RSYNC_RSH [--allow-write=<dir>] \
 *     [--allow-run=rsync --allow-write=$TMPDIR] tools/sync-config/mod.ts [--source <appHome>] \
 *     --target <dir | [user@]host:path> [--include <path>]... [--rsh <remote shell>] [--apply]
 */

import { basename, dirname, isAbsolute, join, resolve, SEPARATOR } from "@std/path";
import { CONTRACT_PINS, type ContractPins } from "../../packages/bridge/src/compat/pins.ts";
import { ProfileSet } from "../../packages/bridge/src/policy/profiles.ts";
import manifest from "../../fixtures/generic-home/MANIFEST.json" with { type: "json" };

/** Files Herdr writes into mod folders itself (`herdr-app check`); never synced, at any depth. */
export const APP_WRITTEN: readonly string[] = ["gpui-kit.d.ts", "jsconfig.json"];
/** A layout, mod or theme name sync-config handles (also keeps rsync filter rules free of wildcards). */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** A layout's own preview (`"preview": "layouts/<name>.svg"` or png). */
const PREVIEW = /^layouts\/([A-Za-z0-9_][A-Za-z0-9._-]*)\.(svg|png)$/;
/** Characters rsync reads as a pattern in a filter rule. */
const WILDCARD = /[*?[\\]/;

/** Pinned sha256 of the shipped default files (`programs.json`, `themes/*.json`, …) by app-home path. */
export const SHIPPED_DEFAULTS: Readonly<Record<string, string>> = manifest.files;

/** The built-in profile lookup {@link planSync} needs: the folders governed together with a folder. */
export interface FolderProfiles {
  profileFor(folder: string): { readonly folders: readonly string[] };
}

export interface PlanOptions {
  /** Contract pins naming shipped mods and layouts; default the bridge's. */
  pins?: ContractPins;
  /** sha256 of shipped default files by path; default {@link SHIPPED_DEFAULTS}. */
  shippedDefaults?: Readonly<Record<string, string>>;
  /** Default: the bridge's built-in profiles (`packages/bridge/profiles`). */
  profiles?: FolderProfiles;
  /** Review-by-hand paths to copy too (each must be in the plan's `optIn` list). */
  include?: readonly string[];
}

/** What one sync copies and merges, every list sorted; paths are relative to the source with `/`. */
export interface SyncPlan {
  /** The source app home, real path. */
  source: string;
  /** Regular files to copy. */
  files: string[];
  /** User layouts synced, by name. */
  layouts: string[];
  /** Mod folders synced. */
  mods: string[];
  /** `keys.json` sections merged (present in the source's `keys.json`). */
  keysSections: string[];
  /** Those sections' bindings, as the source has them. */
  keys: Record<string, Record<string, unknown>>;
  /** Review-by-hand files not copied: differ from the shipped defaults; `--include <path>` adds one. */
  optIn: string[];
  /** Entries a synced layout or mod brings that are not copied, with why. */
  skipped: { path: string; reason: string }[];
}

export type Target = { kind: "local"; path: string } | { kind: "remote"; spec: string };

export type KeysOutcome = "merged" | "unchanged" | "no-target-keys" | "no-sections";

export interface ApplyResult {
  copied: string[];
  keys: KeysOutcome;
}

/** A problem with the source, the target or their files: nothing (more) is written. */
export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

/** A malformed command line (exit 2). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (values: Iterable<string>) => [...values].sort(byPath);

async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

async function entriesOf(dir: string): Promise<Deno.DirEntry[]> {
  const info = await lstatOrNull(dir);
  if (!info?.isDirectory) return [];
  const list: Deno.DirEntry[] = [];
  for await (const e of Deno.readDir(dir)) list.push(e);
  return list.sort((a, b) => byPath(a.name, b.name));
}

async function sha256(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await Deno.readFile(path));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const notCopied = (info: { isSymlink: boolean }) => (info.isSymlink ? "symbolic link" : "not a regular file");

/** Shipped mod names and `layout:<name>` keys: every pinned version's, plus the source's own `installed.json`. */
async function shippedNames(source: string, pins: ContractPins): Promise<Set<string>> {
  const shipped = new Set(Object.values(pins.versions).flatMap((v) => Object.keys(v.installed)));
  const file = join(source, "installed.json");
  const info = await lstatOrNull(file);
  if (!info?.isFile) return shipped;
  let installed: unknown;
  try {
    installed = JSON.parse(await Deno.readTextFile(file));
  } catch {
    throw new SyncError("installed.json is not JSON");
  }
  if (!isObject(installed) || !Object.values(installed).every(isObject)) {
    throw new SyncError("installed.json is not Herdr's list of shipped files");
  }
  for (const key of Object.keys(installed)) shipped.add(key);
  return shipped;
}

/** Mods and themes a layout tree names; `props` are the mod's own data and are not read. */
function collectRefs(value: unknown, mods: Set<string>, themes: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, mods, themes);
    return;
  }
  if (!isObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (k === "props") continue;
    if ((k === "mod" || k === "header" || k === "terminal_menu") && typeof v === "string") mods.add(v);
    else if (k === "theme" && typeof v === "string") themes.add(v);
    else if (k === "theme" && isObject(v)) {
      for (const half of [v.light, v.dark]) if (typeof half === "string") themes.add(half);
    } else collectRefs(v, mods, themes);
  }
}

/** Regular files under `rel` (a folder of the source), minus {@link APP_WRITTEN}; anything else is skipped. */
async function walk(source: string, rel: string, files: Set<string>, skipped: Map<string, string> | null) {
  for (const e of await entriesOf(join(source, rel))) {
    const path = `${rel}/${e.name}`;
    if (e.isDirectory) await walk(source, path, files, skipped);
    else if (!e.isFile) skipped?.set(path, notCopied(e));
    else if (!APP_WRITTEN.includes(e.name)) files.add(path);
  }
}

/** Reads the source (never writes it) and decides what a sync copies; see the module comment. */
export async function planSync(sourceArg: string, options: PlanOptions = {}): Promise<SyncPlan> {
  let source: string;
  try {
    source = await Deno.realPath(sourceArg);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) throw new SyncError(`source ${sourceArg} does not exist`);
    throw e;
  }
  if (!(await Deno.stat(source)).isDirectory) throw new SyncError(`source ${sourceArg} is not a folder`);
  const shipped = await shippedNames(source, options.pins ?? CONTRACT_PINS);
  const defaults = options.shippedDefaults ?? SHIPPED_DEFAULTS;
  const profiles = options.profiles ?? await ProfileSet.load({ log: () => {} });
  const files = new Set<string>();
  const skipped = new Map<string, string>();
  const differs = async (rel: string) => defaults[rel] !== await sha256(join(source, rel));

  const layouts: string[] = [];
  const modRefs = new Set<string>();
  const themeRefs = new Set<string>();
  for (const e of await entriesOf(join(source, "layouts"))) {
    if (!e.name.endsWith(".json") || APP_WRITTEN.includes(e.name)) continue;
    const name = e.name.slice(0, -".json".length);
    if (shipped.has(`layout:${name}`)) continue;
    const rel = `layouts/${e.name}`;
    if (!NAME.test(name)) {
      skipped.set(rel, "name sync-config does not handle");
      continue;
    }
    if (!e.isFile) {
      skipped.set(rel, notCopied(e));
      continue;
    }
    let layout: unknown;
    try {
      layout = JSON.parse(await Deno.readTextFile(join(source, rel)));
    } catch {
      layout = null;
    }
    if (!isObject(layout)) {
      skipped.set(rel, "not a layout (JSON object)");
      continue;
    }
    layouts.push(name);
    files.add(rel);
    collectRefs(layout, modRefs, themeRefs);
    const preview = typeof layout.preview === "string" ? PREVIEW.exec(layout.preview) : null;
    if (preview) {
      const info = await lstatOrNull(join(source, preview[0]));
      if (info?.isFile) files.add(preview[0]);
      else if (info) skipped.set(preview[0], notCopied(info));
    }
  }

  // Referenced user mods, then the folders their profile governs with them (a generated fork's source).
  const referenced = sorted(modRefs).filter((m) => !shipped.has(m));
  const wanted = new Set<string>();
  for (const m of referenced) {
    if (!NAME.test(m)) continue;
    wanted.add(m);
    for (const f of profiles.profileFor(m).folders) if (!shipped.has(f) && NAME.test(f)) wanted.add(f);
  }
  const mods: string[] = [];
  for (const m of sorted(wanted)) {
    const info = await lstatOrNull(join(source, "mods", m));
    if (info?.isDirectory) {
      mods.push(m);
      await walk(source, `mods/${m}`, files, skipped);
    } else if (info) skipped.set(`mods/${m}`, notCopied(info));
    else if (modRefs.has(m)) skipped.set(`mods/${m}`, "named by a layout, not in mods/");
  }

  for (const t of sorted(themeRefs)) {
    const rel = `themes/${t}.json`;
    if (!NAME.test(t) || APP_WRITTEN.includes(`${t}.json`)) continue;
    const info = await lstatOrNull(join(source, rel));
    if (info?.isFile) {
      if (await differs(rel)) files.add(rel);
    } else if (info) skipped.set(rel, notCopied(info));
  }

  const optIn = new Set<string>();
  for (const e of await entriesOf(join(source, "themes"))) {
    const rel = `themes/${e.name}`;
    if (!e.isFile || !e.name.endsWith(".json") || APP_WRITTEN.includes(e.name) || WILDCARD.test(e.name)) continue;
    if (!files.has(rel) && await differs(rel)) optIn.add(rel);
  }
  if ((await lstatOrNull(join(source, "programs.json")))?.isFile && await differs("programs.json")) {
    optIn.add("programs.json");
  }
  const icons = new Set<string>();
  if ((await lstatOrNull(join(source, "my-icons")))?.isDirectory) await walk(source, "my-icons", icons, null);
  for (const rel of icons) if (!WILDCARD.test(rel)) optIn.add(rel);

  for (const raw of options.include ?? []) {
    const rel = raw.replace(/^\.\//, "");
    if (!optIn.has(rel)) {
      throw new UsageError(`--include ${raw}: not a file sync-config lists for review (see "review by hand")`);
    }
    optIn.delete(rel);
    files.add(rel);
  }

  const keys: Record<string, Record<string, unknown>> = {};
  const keysFile = join(source, "keys.json");
  if ((await lstatOrNull(keysFile))?.isFile) {
    let all: unknown;
    try {
      all = JSON.parse(await Deno.readTextFile(keysFile));
    } catch {
      throw new SyncError("the source's keys.json is not JSON");
    }
    if (!isObject(all)) throw new SyncError("the source's keys.json is not an object of sections");
    for (const section of sorted([...layouts.map((l) => `layout:${l}`), ...mods.map((m) => `mod:${m}`)])) {
      if (!Object.hasOwn(all, section)) continue;
      const bindings = all[section];
      if (!isObject(bindings)) throw new SyncError(`the source's keys.json section ${section} is not an object`);
      keys[section] = bindings;
    }
  }

  return {
    source,
    files: sorted(files),
    layouts: sorted(layouts),
    mods,
    keysSections: Object.keys(keys),
    keys,
    optIn: sorted(optIn),
    skipped: sorted(skipped.keys()).map((path) => ({ path, reason: skipped.get(path)! })),
  };
}

/**
 * The rsync filter rules selecting exactly {@link SyncPlan.files} from the source (with `rsync -rtm`: no symbolic
 * links or special files, empty folders pruned): Herdr's own files out, then each synced path and its folders, then
 * everything else out. `keys.json` is merged, never copied.
 */
export function rsyncFilter(plan: SyncPlan): string[] {
  const include = new Set<string>();
  for (const m of plan.mods) include.add("/mods/").add(`/mods/${m}/***`);
  for (const rel of plan.files) {
    if (rel.startsWith("mods/")) continue;
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) include.add(`/${parts.slice(0, i).join("/")}/`);
    include.add(`/${rel}`);
  }
  return [...APP_WRITTEN.map((n) => `- ${n}`), ...sorted(include).map((p) => `+ ${p}`), "- *"];
}

/** Single-quoted for a POSIX shell. */
export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** `rsync <args>` as a POSIX shell line: what is run, printed so a person can run it too. */
export function commandLine(args: readonly string[]): string {
  return ["rsync", ...args.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : shellQuote(a)))].join(" ");
}

/**
 * What a remote target's path and every file sent there may contain: rsync hands the remote path to the remote shell
 * inside a command line (openrsync has no `--protect-args`), so only characters no shell reads are accepted. `:`
 * only separates the host; `@` the user, in `[user@]host`.
 */
const REMOTE_PATH = /^[A-Za-z0-9._/~@+-]+$/;
const REMOTE_HOST = /^(?:[A-Za-z0-9._~+-]+@)?[A-Za-z0-9._~+-]+$/;
const REMOTE_HINT = "use a path without spaces or shell characters (letters, digits and . _ / ~ @ + -)";

/** Throws a {@link UsageError} naming the part of `[user@]host:path` a remote shell would read, if any. */
function checkRemote(spec: string): void {
  const colon = spec.indexOf(":");
  const host = spec.slice(0, Math.max(colon, 0));
  const path = spec.slice(colon + 1);
  if (colon <= 0 || !path) {
    throw new UsageError(`--target ${spec}: a remote target is [user@]host:path, with the app home's path`);
  }
  const bad = !REMOTE_HOST.test(host) ? host : !REMOTE_PATH.test(path) ? path : null;
  if (bad !== null) {
    throw new UsageError(`--target ${spec}: ${JSON.stringify(bad)} has a space or shell character; ${REMOTE_HINT}`);
  }
}

/**
 * Throws a {@link UsageError} when `remote` or a planned file has a character outside {@link REMOTE_PATH}: checked
 * before anything is created or run.
 */
export function checkRemotePlan(plan: SyncPlan, remote: string): void {
  checkRemote(remote);
  const unsafe = plan.files.find((rel) => !REMOTE_PATH.test(rel));
  if (unsafe !== undefined) {
    throw new UsageError(
      `${unsafe}: a file with a space or shell character can't go to a remote target; ${REMOTE_HINT}, or sync to a ` +
        "local folder",
    );
  }
}

/**
 * The rsync runs of a remote `--apply`, in order (argument lists for `rsync`; nothing else runs on the target):
 * - `pullKeys`: the target's `keys.json` alone into `temp` (a filter, so an absent file is no error and is never
 *   created); null when the plan merges no section;
 * - `send`: the plan's files ({@link rsyncFilter}; no `--delete`, folder times untouched); null when there are none;
 * - `pushKeys`: `temp`'s merged `keys.json` back over the target's (run only when the merge changes it).
 * `rsh` is rsync's remote shell (`-e`); `temp` a local folder. Throws as {@link checkRemotePlan}.
 */
export function remoteSteps(
  plan: SyncPlan,
  remote: string,
  rsh: string,
  temp: string,
): { pullKeys: string[] | null; send: string[] | null; pushKeys: string[] | null } {
  checkRemotePlan(plan, remote);
  const to = remote.endsWith("/") ? remote : `${remote}/`;
  const keys = plan.keysSections.length > 0;
  const filter = rsyncFilter(plan).map((r) => `${r[0] === "+" ? "--include" : "--exclude"}=${r.slice(2)}`);
  return {
    pullKeys: keys ? ["-rt", "-e", rsh, "--include=/keys.json", "--exclude=*", to, `${temp}/`] : null,
    send: plan.files.length ? ["-rtm", "--omit-dir-times", "-e", rsh, ...filter, `${plan.source}/`, to] : null,
    pushKeys: keys ? ["-t", "--ignore-times", "-e", rsh, `${temp}/keys.json`, `${to}keys.json`] : null,
  };
}

/** Runs `rsync` with these arguments (a test seam); resolves with its exit code and output. */
export type RsyncRunner = (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The `rsync` on PATH (`--allow-run=rsync`); it starts the remote shell itself. */
export const runRsync: RsyncRunner = async (args) => {
  const out = await new Deno.Command("rsync", { args: [...args], stdin: "null", stdout: "piped", stderr: "piped" })
    .output();
  const text = new TextDecoder();
  return { code: out.code, stdout: text.decode(out.stdout), stderr: text.decode(out.stderr) };
};

/**
 * `target`'s sections in their order with each of `sections` replaced whole by `source`'s; sections the target lacks
 * are appended in sorted order. Every other target section is kept as is.
 */
export function mergeKeys(target: Json, source: Json, sections: readonly string[]): Json {
  const take = new Set(sections.filter((s) => Object.hasOwn(source, s)));
  const entries: [string, unknown][] = Object.entries(target).map(([k, v]) => [k, take.has(k) ? source[k] : v]);
  for (const s of sorted(take)) if (!Object.hasOwn(target, s)) entries.push([s, source[s]]);
  return Object.fromEntries(entries);
}

/**
 * rsync's rule: a `:` before any `/` names a remote `[user@]host:path`; anything else is a local folder. A remote one
 * must keep to {@link REMOTE_PATH} (else a {@link UsageError}).
 */
export function parseTarget(value: string): Target {
  const colon = value.indexOf(":");
  const slash = value.indexOf("/");
  if (colon < 0 || (slash >= 0 && slash < colon)) return { kind: "local", path: value };
  checkRemote(value);
  return { kind: "remote", spec: value };
}

const inside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(SEPARATOR) ? parent : parent + SEPARATOR);

/**
 * The target folder (absolute, as given: writes go there, so `--allow-write=<dir>` matches), created when missing
 * (`create`; else null). Refused when its real path is the source's or either holds the other, checked before
 * anything is created.
 */
async function targetRoot(plan: SyncPlan, dir: string, create: boolean): Promise<string | null> {
  const abs = resolve(dir);
  // The real path of the nearest existing folder, plus the part still to create.
  let existing = abs;
  const missing: string[] = [];
  while (!(await lstatOrNull(existing))) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  const real = join(await Deno.realPath(existing).catch(() => existing), ...missing);
  if (inside(real, plan.source) || inside(plan.source, real)) {
    throw new SyncError(`target ${dir} is the source or overlaps it`);
  }
  if (missing.length) {
    if (!create) return null;
    await Deno.mkdir(abs, { recursive: true });
  }
  if (!(await Deno.stat(abs)).isDirectory) throw new SyncError(`target ${dir} is not a folder`);
  return abs;
}

/** Every existing step of `rel` under `root` is a real folder (the last one a regular file, if present). */
async function checkDestination(root: string, rel: string): Promise<void> {
  const parts = rel.split("/");
  for (let i = 0; i < parts.length; i++) {
    const path = join(root, ...parts.slice(0, i + 1));
    const info = await lstatOrNull(path);
    if (!info) return;
    const last = i === parts.length - 1;
    if (info.isSymlink) throw new SyncError(`target ${parts.slice(0, i + 1).join("/")} is a symbolic link`);
    if (last ? !info.isFile : !info.isDirectory) {
      throw new SyncError(`target ${parts.slice(0, i + 1).join("/")} is not a ${last ? "file" : "folder"}`);
    }
  }
}

/** What the target's keys.json becomes; `text` is set only when it changes. */
async function keysMerge(plan: SyncPlan, root: string | null): Promise<{ outcome: KeysOutcome; text?: string }> {
  if (!plan.keysSections.length) return { outcome: "no-sections" };
  if (!root) return { outcome: "no-target-keys" };
  const file = join(root, "keys.json");
  const info = await lstatOrNull(file);
  if (!info) return { outcome: "no-target-keys" };
  if (!info.isFile) throw new SyncError(`target keys.json is a ${info.isSymlink ? "symbolic link" : "folder"}`);
  let current: unknown;
  try {
    current = JSON.parse(await Deno.readTextFile(file));
  } catch {
    throw new SyncError("target keys.json is not JSON");
  }
  if (!isObject(current)) throw new SyncError("target keys.json is not an object of sections");
  const merged = mergeKeys(current, plan.keys, plan.keysSections);
  if (JSON.stringify(merged) === JSON.stringify(current)) return { outcome: "unchanged" };
  return { outcome: "merged", text: `${JSON.stringify(merged, null, 2)}\n` };
}

/**
 * Copies the plan's files into the local folder `dir` (created when missing; files keep their modification time)
 * and merges keys.json. Everything is checked before the first write; a target without keys.json gets none.
 */
export async function applySync(plan: SyncPlan, dir: string): Promise<ApplyResult> {
  const root = (await targetRoot(plan, dir, true))!;
  for (const rel of plan.files) await checkDestination(root, rel);
  const keys = await keysMerge(plan, root);
  const copied: string[] = [];
  for (const rel of plan.files) {
    const from = join(plan.source, ...rel.split("/"));
    const info = await Deno.lstat(from);
    if (!info.isFile) throw new SyncError(`source ${rel} changed while syncing`);
    const to = join(root, ...rel.split("/"));
    await Deno.mkdir(join(to, ".."), { recursive: true });
    await Deno.copyFile(from, to);
    if (info.mtime) await Deno.utime(to, info.atime ?? info.mtime, info.mtime);
    copied.push(rel);
  }
  if (keys.text !== undefined) {
    const tmp = join(root, `.keys.json.sync-config-${Deno.pid}`);
    await Deno.writeTextFile(tmp, keys.text);
    await Deno.rename(tmp, join(root, "keys.json"));
  }
  return { copied, keys: keys.outcome };
}

/** A remote `--apply`: `copied` lists the files rsync made identical on the target; `commands` every rsync run. */
export interface RemoteApplyResult extends ApplyResult {
  commands: string[];
}

/**
 * Applies the plan to `remote` (`[user@]host:path`) with rsync over `rsh` and nothing else ({@link remoteSteps}):
 * pulls the target's keys.json into a fresh local temporary folder and merges it there (an invalid one stops before
 * anything is sent; an absent one is never created), sends the files, then sends the merged keys.json back when it
 * changed. A failed run stops the rest and says what was sent. The temporary folder is removed. {@link checkRemotePlan}
 * runs first: an unsafe target or file creates nothing and runs nothing.
 */
export async function applyRemote(
  plan: SyncPlan,
  remote: string,
  /** `rsh`: rsync's remote shell; `run`: default {@link runRsync}; `tempDir`: where the temporary folder is made. */
  o: { rsh: string; run?: RsyncRunner; tempDir?: string },
): Promise<RemoteApplyResult> {
  checkRemotePlan(plan, remote);
  const run = o.run ?? runRsync;
  const commands: string[] = [];
  const step = async (args: string[], failed: string) => {
    commands.push(commandLine(args));
    const r = await run(args);
    if (r.code === 0) return;
    const why = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join("; ");
    throw new SyncError(`${failed} (rsync exited ${r.code}${why ? `: ${why}` : ""})`);
  };
  const temp = plan.keysSections.length ? await Deno.makeTempDir({ prefix: "sync-config-", dir: o.tempDir }) : "";
  try {
    const steps = remoteSteps(plan, remote, o.rsh, temp);
    let keys: { outcome: KeysOutcome; text?: string } = { outcome: "no-sections" };
    if (steps.pullKeys) {
      await step(steps.pullKeys, "reading the target's keys.json failed; nothing was sent");
      keys = await keysMerge(plan, temp);
    }
    if (steps.send) {
      await step(steps.send, "sending the files failed (some may have been sent); keys.json was not merged");
    }
    if (keys.text !== undefined && steps.pushKeys) {
      await Deno.writeTextFile(join(temp, "keys.json"), keys.text);
      await step(steps.pushKeys, "sending the merged keys.json failed; the files were sent");
    }
    return { copied: plan.files, keys: keys.outcome, commands };
  } finally {
    if (temp) await Deno.remove(temp, { recursive: true });
  }
}

function keysLine(plan: SyncPlan, outcome: KeysOutcome, remote: boolean, applied: boolean): string {
  const list = plan.keysSections.join(", ");
  if (outcome === "no-sections") return "keys.json: no section to merge";
  if (remote && !applied) {
    return `keys.json: merge ${list} (--apply reads the target's keys.json, merges here, sends it back if it changes)`;
  }
  if (outcome === "no-target-keys") {
    return `keys.json: ${list} not merged: the target has no keys.json (start Herdr there once, then run again)`;
  }
  if (outcome === "unchanged") return `keys.json: ${list} already match`;
  return `keys.json: ${applied ? "merged" : "merge"} ${list}`;
}

/**
 * The report main prints; one item per line, lists indented by two spaces. `commands`: for a remote target, the rsync
 * lines `--apply` runs (dry run) or ran.
 */
export function formatReport(
  plan: SyncPlan,
  o: { target: Target; keys: KeysOutcome; applied?: ApplyResult; commands?: readonly string[] },
): string {
  const remote = o.target.kind === "remote";
  const lines = [
    o.applied ? "sync-config: applied" : "sync-config: dry run, nothing written",
    `source: ${plan.source} (read only)`,
    `target: ${o.target.kind === "remote" ? o.target.spec : o.target.path}`,
  ];
  const files = o.applied?.copied ?? plan.files;
  lines.push(
    `${o.applied ? (remote ? "synced" : "copied") : "copy"} (${files.length}):`,
    ...files.map((f) => `  ${f}`),
  );
  lines.push(keysLine(plan, o.keys, remote, Boolean(o.applied)));
  if (plan.skipped.length) lines.push("skipped:", ...plan.skipped.map((s) => `  ${s.path}: ${s.reason}`));
  if (plan.optIn.length) {
    lines.push(
      "review by hand (not synced; add the flag to include it):",
      ...plan.optIn.map((p) => `  --include ${p}`),
    );
  }
  lines.push("rsync filter:", ...rsyncFilter(plan).map((r) => `  ${r}`));
  if (o.commands && !o.commands.length) lines.push("rsync runs: none (nothing to send or merge)");
  else if (o.commands) {
    lines.push(
      o.applied
        ? "rsync runs:"
        : "rsync runs with --apply, in order (<temp>: a fresh local temporary folder; the last only if keys.json changes):",
      ...o.commands.map((c) => `  ${c}`),
    );
  }
  return lines.join("\n");
}

const USAGE = "usage: sync-config [--source <appHome>] --target <dir | [user@]host:path> [--include <path>]... " +
  "[--rsh <remote shell>] [--apply]";

interface Args {
  source: string | null;
  target: string;
  include: string[];
  rsh: string | null;
  apply: boolean;
}

const VALUE_FLAGS = ["--source", "--target", "--include", "--rsh"];

function parseArgs(args: readonly string[]): Args | "help" {
  const out: Args = { source: null, target: "", include: [], rsh: null, apply: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--apply") {
      out.apply = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (!VALUE_FLAGS.includes(flag)) throw new UsageError(`unknown ${arg}`);
    const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
    if (!value) throw new UsageError(`${flag} needs a value`);
    if (flag === "--source") out.source = value;
    else if (flag === "--target") out.target = value;
    else if (flag === "--rsh") out.rsh = value;
    else out.include.push(value);
  }
  if (!out.target) throw new UsageError("--target is required");
  return out;
}

/** `$HERDR_APP_HOME`, else `$HOME/.config/herdr-app` (as the bridge resolves it). */
function defaultSource(): string {
  const appHome = Deno.env.get("HERDR_APP_HOME");
  if (appHome) {
    if (!isAbsolute(appHome)) throw new SyncError("HERDR_APP_HOME must be an absolute path");
    return appHome;
  }
  const home = Deno.env.get("HOME");
  if (!home) throw new SyncError("HOME is not set: give --source");
  return join(home, ".config", "herdr-app");
}

/** The command line; returns the exit code (0 done, 1 error, 2 usage). */
export async function main(args: readonly string[]): Promise<number> {
  try {
    const parsed = parseArgs(args);
    if (parsed === "help") {
      console.log(USAGE);
      return 0;
    }
    const target = parseTarget(parsed.target);
    if (parsed.rsh !== null && target.kind === "local") throw new UsageError("--rsh is for a remote target");
    const plan = await planSync(parsed.source ?? defaultSource(), { include: parsed.include });
    if (target.kind === "remote") {
      // Before anything else is read, created or run.
      checkRemotePlan(plan, target.spec);
      // rsync's own order: -e (here --rsh), then RSYNC_RSH, then ssh.
      const rsh = parsed.rsh ?? (Deno.env.get("RSYNC_RSH") || "ssh");
      if (parsed.apply) {
        const applied = await applyRemote(plan, target.spec, { rsh });
        console.log(formatReport(plan, { target, keys: applied.keys, applied, commands: applied.commands }));
        return 0;
      }
      const steps = remoteSteps(plan, target.spec, rsh, "<temp>");
      const commands = [steps.pullKeys, steps.send, steps.pushKeys].filter((s) => s !== null).map(commandLine);
      console.log(formatReport(plan, { target, keys: plan.keysSections.length ? "merged" : "no-sections", commands }));
      return 0;
    }
    if (!parsed.apply) {
      const keys = await keysMerge(plan, await targetRoot(plan, target.path, false));
      console.log(formatReport(plan, { target, keys: keys.outcome }));
      return 0;
    }
    const applied = await applySync(plan, target.path);
    console.log(formatReport(plan, { target, keys: applied.keys, applied }));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`sync-config: ${e.message}\n${USAGE}`);
      return 2;
    }
    // Ours, a missing permission (Deno names the flag) or a filesystem error: the message is the report.
    if (e instanceof SyncError || (e instanceof Error && Object.values(Deno.errors).some((c) => e instanceof c))) {
      console.error(`sync-config: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
