/**
 * Read policy (DESIGN-v2 §2.1, §2.2; OSS-PLAN §1): what `herdr.readTextFile`, `watchFolder`, exec `cwd`/`-C`/script/
 * picture paths and the static asset route may touch. Read roots are per mod folder: its own folder, `data/<folder>`
 * and (unless its profile says otherwise) the space folders, plus the patterns its profile names. Migrated from
 * the Deno spike's `policyRead` (`docs/spikes/deno.md`): lexical check under a root, then `realPath`, then the real
 * path under a real root; never trust the lexical form alone.
 */

import { basename, dirname, extname, join } from "@std/path";
import type { PolicyProfile } from "@herdr-relay/protocol";
import { refuse } from "./decision.ts";
import { lexical, realPathOrNull, relativeInside, resolveReal, within } from "./paths.ts";

/** `<appHome>/cockpit.json` as `cockpit app install` writes it (read by the bridge itself, never trusted from mods). */
export interface CockpitInstall {
  bin?: string;
  cache?: string;
  home?: string;
  version?: string;
  env?: Record<string, string>;
}

/**
 * One read root. `dir`: the folder and everything under it; `file`: exactly that file; `glob`: the entries of the
 * folder `path` whose name matches `name` (`*` = any characters but `/`).
 */
export interface ReadRootSpec {
  path: string;
  kind: "dir" | "file" | "glob";
  /** `glob` only: the entry name pattern. */
  name?: string;
}

export interface ReadRootsInput {
  /** The user's `$HOME`. */
  home: string;
  /** `<appHome>` as configured (`~/.config/herdr-app` or `HERDR_APP_HOME`); may itself be a symlink. */
  appHome: string;
  /** Every `spaces[].folder` of the core `herdr-app` document (refreshed on `doc` events). */
  spaceFolders: readonly string[];
  /** Parsed `<appHome>/cockpit.json`, or null when cockpit is not installed (`$cockpit.cache`/`$cockpit.home`). */
  cockpit: CockpitInstall | null;
}

/** A profile path pattern (validated by the profile schema) under `base`, with `{folder}` substituted. */
function patternRoot(base: string, pattern: string, folder: string): ReadRootSpec {
  const parts = pattern.replaceAll("{folder}", folder).split("/").filter((s) => s !== "");
  const last = parts.at(-1) ?? "**";
  if (last === "**") return { kind: "dir", path: join(base, ...parts.slice(0, -1)) };
  if (last.includes("*")) return { kind: "glob", path: join(base, ...parts.slice(0, -1)), name: last };
  return { kind: "file", path: join(base, ...parts) };
}

/** An `extra` path under its base (`~/`, `/`, `$cockpit.cache/`, `$cockpit.home/`); null while the base is unknown. */
function extraRoot(input: ReadRootsInput, path: string, folder: string): ReadRootSpec | null {
  const slash = path.indexOf("/");
  const bases: Readonly<Record<string, unknown>> = {
    "": "/",
    "~": input.home,
    "$cockpit.cache": input.cockpit?.cache,
    "$cockpit.home": input.cockpit?.home,
  };
  const head = path.slice(0, slash);
  const base = Object.hasOwn(bases, head) ? bases[head] : null;
  return typeof base === "string" && base.startsWith("/") ? patternRoot(base, path.slice(slash + 1), folder) : null;
}

/**
 * The read roots of mod folder `folder` under `profile`: `<appHome>/mods/<folder>`, `<appHome>/data/<folder>`, every
 * space folder unless `reads.spaces` is false, then `reads.appHome` (relative to appHome) and `reads.extra`.
 */
export function folderRootSpecs(input: ReadRootsInput, folder: string, profile: PolicyProfile): ReadRootSpec[] {
  const specs: ReadRootSpec[] = [
    { path: join(input.appHome, "mods", folder), kind: "dir" },
    { path: join(input.appHome, "data", folder), kind: "dir" },
  ];
  if (profile.reads?.spaces !== false) {
    for (const space of input.spaceFolders) if (space.startsWith("/")) specs.push({ path: space, kind: "dir" });
  }
  for (const p of profile.reads?.appHome ?? []) specs.push(patternRoot(input.appHome, p, folder));
  for (const p of profile.reads?.extra ?? []) {
    const spec = extraRoot(input, p, folder);
    if (spec !== null) specs.push(spec);
  }
  const seen = new Set<string>();
  return specs.map((s) => ({ ...s, path: lexical(s.path, "/") })).filter((s) => {
    const key = `${s.kind}\0${s.path}\0${s.name ?? ""}`;
    return !seen.has(key) && seen.add(key);
  });
}

interface Root extends ReadRootSpec {
  real: string | null;
  /** `glob` only: `name` as a regular expression. */
  match: RegExp | null;
}

/**
 * The resolved roots. Roots that do not exist yet (e.g. `~/.cache/lstack-herdr` before the first scan) are realpath'ed
 * again when a check needs them; a root that resolves to a file when it should be a directory (or back) is ignored.
 */
export class ReadRoots {
  readonly appHome: string;
  readonly appHomeReal: string;
  readonly #roots: Root[];

  private constructor(appHome: string, appHomeReal: string, roots: Root[]) {
    this.appHome = appHome;
    this.appHomeReal = appHomeReal;
    this.#roots = roots;
  }

  /** Realpaths every root. `appHome` must exist; with no specs nothing is readable (only `appHome` is resolved). */
  static async resolve(appHome: string, specs: readonly ReadRootSpec[]): Promise<ReadRoots> {
    const home = lexical(appHome, "/");
    const homeReal = await Deno.realPath(home);
    const roots: Root[] = [];
    for (const s of specs) {
      // `*` = any characters but `/`; everything else literal.
      const match = s.kind === "glob"
        ? new RegExp(
          `^${(s.name ?? "").split("*").map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`,
        )
        : null;
      roots.push({ ...s, real: await realRoot(s), match });
    }
    return new ReadRoots(home, homeReal, roots);
  }

  /** The specs, as given. */
  get specs(): ReadRootSpec[] {
    return this.#roots.map(({ path, kind, name }) => (name === undefined ? { path, kind } : { path, kind, name }));
  }

  /** Lexical check: `abs` (normalized) is under a root's configured path or its real path. */
  lexicallyInside(abs: string): boolean {
    return this.#roots.some((r) => contains(r, r.path, abs) || (r.real !== null && contains(r, r.real, abs)));
  }

  /** Real check: `real` (a real path) is under a root's real path. */
  async reallyInside(real: string): Promise<boolean> {
    for (const r of this.#roots) {
      if (r.real === null) r.real = await realRoot(r);
      if (r.real !== null && contains(r, r.real, real)) return true;
    }
    return false;
  }
}

function contains(root: Root, rootPath: string, p: string): boolean {
  if (root.kind === "file") return p === rootPath;
  if (root.kind === "glob") return p !== rootPath && dirname(p) === rootPath && root.match!.test(basename(p));
  return within(p, rootPath);
}

/** The root's real path; null when missing or of the wrong type (a `glob` root's folder must be a folder). */
async function realRoot(spec: ReadRootSpec): Promise<string | null> {
  const real = await realPathOrNull(spec.path).catch(() => null);
  if (real === null) return null;
  const st = await Deno.stat(real).catch(() => null);
  if (!st || (spec.kind === "file" ? !st.isFile : !st.isDirectory)) return null;
  return real;
}

/** Largest file `readTextFile` returns (DESIGN-v2 §2.1). */
export const READ_MAX_BYTES = 1024 * 1024;

/**
 * Resolves a mod-supplied path under the read roots: lexical check (relative paths are against appHome, as Herdr
 * does), then real check. Returns the real path, or `null` when nothing exists there while the deepest existing
 * ancestor is inside the roots; refuses (`read`) otherwise. `what` names the argument in refusal messages.
 */
export async function resolveUnderRoots(roots: ReadRoots, p: string, what = "path"): Promise<string | null> {
  if (typeof p !== "string" || p === "" || p.includes("\0")) refuse("read", `${what} is not a path`);
  const abs = lexical(p, roots.appHome);
  if (!roots.lexicallyInside(abs)) refuse("read", `${what} ${p} is outside the readable folders`);
  const { real, exists } = await resolveReal(abs);
  if (!(await roots.reallyInside(real))) refuse("read", `${what} ${p} resolves outside the readable folders`);
  return exists ? real : null;
}

/** `resolveUnderRoots` for a directory argument (`cwd`, `git -C`, `watchFolder`); refuses a missing one or a file. */
export async function resolveDirUnderRoots(roots: ReadRoots, p: string, what = "folder"): Promise<string> {
  const real = await resolveUnderRoots(roots, p, what);
  if (real === null) refuse("read", `${what} ${p} does not exist`);
  const st = await Deno.stat(real);
  if (!st.isDirectory) refuse("read", `${what} ${p} is not a folder`);
  return real;
}

/**
 * `herdr.readTextFile(path)` under the policy: the file's text, `null` when it does not exist (Herdr semantics), a
 * refusal (`read`) outside the roots or over 1 MiB. The file is opened by its real path and sized from the open handle.
 */
export async function policyReadTextFile(roots: ReadRoots, p: string): Promise<string | null> {
  const real = await resolveUnderRoots(roots, p);
  if (real === null) return null;
  let file: Deno.FsFile;
  try {
    file = await Deno.open(real, { read: true });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  try {
    const st = await file.stat();
    if (!st.isFile) refuse("read", `${p} is not a file`);
    if (st.size > READ_MAX_BYTES) refuse("read", `${p} is over 1 MiB`);
    const buf = new Uint8Array(READ_MAX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const got = await file.read(buf.subarray(n));
      if (got === null) break;
      n += got;
    }
    if (n > READ_MAX_BYTES) refuse("read", `${p} is over 1 MiB`);
    return new TextDecoder().decode(buf.subarray(0, n));
  } finally {
    file.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Static asset route `/herdr-relay/assets/*` (icons for `svg()`/`image()`, mod sounds for `playSound()`).

/** Keyed by a requested path's extension: a `Map`/`Set`, so no `Object.prototype` name is ever an entry. */
const IMAGE_TYPES: ReadonlyMap<string, string> = new Map([
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
]);
const MOD_IMAGE: ReadonlySet<string> = new Set([".svg", ".png", ".jpg", ".webp"]);
/** A mod's own sound files, for `playSound("mods/<name>/…")` (herdr.d.ts: "an MP3 file … relative to appHome"). */
const MOD_AUDIO: ReadonlyMap<string, string> = new Map([
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
]);

/**
 * Content-Type of an allowlisted asset path (relative to appHome, `/`-separated), or null when not allowlisted.
 * `svg()`/`image()` resolve against the application root, Herdr's appHome (gpui-kit.d.ts `svg`/`image`; herdr.d.ts
 * `Program.icon`: "a path in the home folder"); Herdr 0.1.14's shipped mods draw from `mods/`, `icons/`, `layouts/` and
 * `frame/` (`workspace-chrome/main.js:50`: `frame/welcome/herdr.png`, the frame's own welcome screen), users from
 * `my-icons/`. Only image files there are served, and under `mods/` also sound files (mp3, wav, ogg).
 */
export function assetContentType(rel: string): string | null {
  const parts = rel.split("/");
  const ext = extname(rel).toLowerCase();
  if (parts[0] === "mods" && parts.length >= 3) {
    return MOD_IMAGE.has(ext) ? IMAGE_TYPES.get(ext)! : MOD_AUDIO.get(ext) ?? null;
  }
  if (parts[0] === "frame" && parts.length >= 3) return IMAGE_TYPES.get(ext) ?? null;
  if ((parts[0] === "icons" || parts[0] === "my-icons") && parts.length >= 2) return IMAGE_TYPES.get(ext) ?? null;
  if (parts[0] === "layouts" && parts.length === 2) return ext === ".svg" ? IMAGE_TYPES.get(ext)! : null;
  if (parts[0] === "data" && parts[1] === "cockpit" && parts[2] === "show" && parts.length >= 4) {
    return IMAGE_TYPES.get(ext) ?? "application/octet-stream";
  }
  return null;
}

export interface Asset {
  /** Real path to serve. */
  path: string;
  contentType: string;
  size: number;
}

/**
 * Resolves `/herdr-relay/assets/<rel>` (rel already URL-decoded): allowlist `mods/**\/*.svg|png|jpg|webp|mp3|wav|ogg`,
 * `frame/<name>/**` images, `icons/**`, `my-icons/**`, `layouts/*.svg`, `data/cockpit/show/**`; the same rule applies
 * to the real path relative to the real appHome, so a link inside appHome cannot reach another part of it.
 * Content-Type by extension only. `null` = 404.
 */
export async function resolveAsset(roots: ReadRoots, rel: string): Promise<Asset | null> {
  if (rel === "" || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/")) return null;
  const parts = rel.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return null;
  const contentType = assetContentType(rel);
  if (contentType === null) return null;
  const real = await realPathOrNull(join(roots.appHome, rel)).catch(() => null);
  if (real === null) return null;
  const realRel = relativeInside(real, roots.appHomeReal);
  if (realRel === null || assetContentType(realRel) !== contentType) return null;
  const st = await Deno.stat(real).catch(() => null);
  if (!st?.isFile) return null;
  return { path: real, contentType, size: st.size };
}
