/**
 * `herdr-relay install-mod [--app-home DIR]` (OSS-PLAN §5, T44/T45): copies the repository's
 * `mods/herdr-relay-mirror/` into `<appHome>/mods/herdr-relay-mirror/` — a copy, never a link (the bridge's symlink
 * audit refuses linked mod folders). The app home is `--app-home`, else `HERDR_APP_HOME`, else
 * `$HOME/.config/herdr-app`; its `mods/` must exist.
 *
 * - Absent: installed. Older (`mod.json` `version`): replaced. Same version with identical files: nothing to do.
 * - Refused, nothing written: a newer installed version (no downgrade), the same version with different files (edited
 *   by hand), an installed copy whose version cannot be read, a link or a file in its place.
 * - The copy is staged in `<appHome>/data/herdr-relay/` (outside `mods/`, so Herdr never sees half a folder) and
 *   renamed into place; a replaced copy is moved aside first and removed after.
 *
 * Herdr runs the mod only in layouts that place it. herdr-relay never edits layouts: the command prints the entry to
 * add (`RECIPE.md` "Placement").
 */

import { join } from "@std/path";
import { compareVersions } from "../src/compat/pins.ts";
import { messageOf } from "../src/core/errors.ts";
import { MIRROR_CACHE_DIR } from "../src/mirror.ts";
import { REPO } from "./host.ts";

export const MIRROR_MOD = "herdr-relay-mirror";
/** The bundled copy `install-mod` installs. */
export const MIRROR_MOD_DIR = join(REPO, "mods", MIRROR_MOD);

/** The layout entry the user adds to the root node's `floating` list (RECIPE.md). */
export const MIRROR_LAYOUT_ENTRY =
  `{ "id": "${MIRROR_MOD}", "content": { "mod": "${MIRROR_MOD}" }, "edge": "bottom", "align": "end" }`;

class Refusal extends Error {}

/** `<folder>/mod.json`'s `version`; a {@link Refusal} naming `what` when it cannot be read. */
export async function modVersion(folder: string, what = folder): Promise<string> {
  let data: { version?: unknown };
  try {
    data = JSON.parse(await Deno.readTextFile(join(folder, "mod.json")));
  } catch (e) {
    throw new Refusal(`cannot read ${what}/mod.json (${messageOf(e)})`);
  }
  if (typeof data?.version !== "string" || data.version === "") throw new Refusal(`${what}/mod.json has no version`);
  return data.version;
}

/** Every regular file under `dir` (relative path → bytes); a {@link Refusal} on a link or other non-file. */
async function readTree(dir: string, prefix = ""): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for await (const entry of Deno.readDir(join(dir, prefix))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymlink) throw new Refusal(`${join(dir, rel)} is a symbolic link`);
    if (entry.isDirectory) { for (const [k, v] of await readTree(dir, rel)) files.set(k, v); }
    else if (entry.isFile) files.set(rel, await Deno.readFile(join(dir, rel)));
    else throw new Refusal(`${join(dir, rel)} is not a regular file`);
  }
  return files;
}

function sameTree(a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): boolean {
  if (a.size !== b.size) return false;
  for (const [rel, bytes] of a) {
    const other = b.get(rel);
    if (other === undefined || other.length !== bytes.length || other.some((byte, i) => byte !== bytes[i])) {
      return false;
    }
  }
  return true;
}

async function writeTree(dest: string, files: Map<string, Uint8Array>): Promise<void> {
  await Deno.mkdir(dest, { mode: 0o755 });
  for (const [rel, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const path = join(dest, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true, mode: 0o755 });
    await Deno.writeFile(path, bytes, { createNew: true, mode: 0o644 });
  }
}

export interface InstallModOptions {
  /** The target app home (absolute). */
  appHome: string;
  /** The folder to install; default {@link MIRROR_MOD_DIR}. */
  source?: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Installs the mirror mod; resolves to the exit code (0 installed or up to date, 1 refused or failed). */
export async function installMod(o: InstallModOptions): Promise<number> {
  const target = join(o.appHome, "mods", MIRROR_MOD);
  let outcome: string;
  try {
    outcome = await install(o.appHome, target, o.source ?? MIRROR_MOD_DIR);
  } catch (e) {
    o.err(`herdr-relay: install-mod: ${e instanceof Refusal ? e.message : messageOf(e)}`);
    return 1;
  }
  o.out(outcome);
  o.out(
    "Herdr runs it only in layouts that place it; herdr-relay never edits layouts. Add this entry to the root node " +
      'of each layout you show (into its "floating" list if it has one); Herdr\'s shipped layouts are read-only, so ' +
      "clone one first (layout.clone):",
  );
  o.out(`  "floating": [ ${MIRROR_LAYOUT_ENTRY} ]`);
  o.out(`Check it with: herdr-app check ${target}`);
  return 0;
}

/** Installs `source` as `target` unless refused; resolves to what was done. */
async function install(appHome: string, target: string, source: string): Promise<string> {
  if (!appHome.startsWith("/")) throw new Refusal(`the app home must be an absolute path, got "${appHome}"`);
  const bundled = await modVersion(source, `the bundled ${MIRROR_MOD}`);
  const files = await readTree(source);
  const mods = join(appHome, "mods");
  if (!(await Deno.stat(mods).catch(() => null))?.isDirectory) {
    throw new Refusal(`${mods} is not a directory: is ${appHome} a Herdr app home?`);
  }
  const installed = await Deno.lstat(target).catch((e) => {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  });
  if (installed === null) {
    await place(appHome, target, files);
    return `Installed ${MIRROR_MOD} ${bundled} in ${target}.`;
  }
  if (installed.isSymlink) {
    throw new Refusal(`${target} is a symbolic link (the bridge refuses linked mod folders); remove it first`);
  }
  if (!installed.isDirectory) throw new Refusal(`${target} is not a folder; remove it first`);
  const previous = await modVersion(target, target);
  const order = compareVersions(previous, bundled);
  if (order > 0) {
    throw new Refusal(
      `${target} is ${MIRROR_MOD} ${previous}, newer than this herdr-relay's ${bundled}; not downgrading`,
    );
  }
  if (order < 0) {
    await place(appHome, target, files);
    return `Installed ${MIRROR_MOD} ${bundled} in ${target} (replacing ${previous}).`;
  }
  if (!sameTree(await readTree(target), files)) {
    throw new Refusal(
      `${target} is ${MIRROR_MOD} ${bundled} but its files differ from the bundled copy (edited?); remove it to reinstall`,
    );
  }
  return `${MIRROR_MOD} ${bundled} is already installed in ${target}.`;
}

/** Stages `files` beside the bridge's app-home data and renames them into `target`, moving an older copy aside. */
async function place(appHome: string, target: string, files: Map<string, Uint8Array>): Promise<void> {
  const staging = join(appHome, MIRROR_CACHE_DIR);
  await Deno.mkdir(staging, { recursive: true, mode: 0o700 });
  const fresh = join(staging, `${MIRROR_MOD}.new-${Deno.pid}`);
  const old = join(staging, `${MIRROR_MOD}.old-${Deno.pid}`);
  await writeTree(fresh, files);
  let movedAside = false;
  try {
    try {
      await Deno.rename(target, old);
      movedAside = true;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    await Deno.rename(fresh, target);
  } catch (e) {
    if (movedAside) await Deno.rename(old, target).catch(() => {});
    await Deno.remove(fresh, { recursive: true }).catch(() => {});
    throw e;
  }
  if (movedAside) await Deno.remove(old, { recursive: true });
}
