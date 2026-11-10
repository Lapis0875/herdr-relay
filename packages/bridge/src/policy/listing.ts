/**
 * Native replacement for the `files` mod's directory literal (DESIGN-v2 §2.3 E14), so no shell runs:
 *
 *   n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*\/};
 *   [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\0%s\0" "$kind" "$name";
 *   n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"
 *
 * Same stream (`kind\0name\0`, `d` when the entry or a link's target is a directory), same order of the three glob
 * groups (plain names, then `.x…`, then `..x…`), `.git` skipped, at most 501 entries, exit 0 iff the path is a
 * directory. Within a group names are in code-point order (the shell's glob order under the C locale; the mod sorts
 * the entries itself).
 */

import { join } from "@std/path";
import type { ExecResult } from "./decision.ts";

/** Entries printed before the loop breaks (`n` > 500 after the 501st). */
export const LISTING_MAX_ENTRIES = 501;

/** `dir` is the real path the policy already checked, or null when the requested path does not exist. */
export async function listDirectory(dir: string | null): Promise<ExecResult> {
  const st = dir === null ? null : await Deno.stat(dir).catch(() => null);
  if (dir === null || !st?.isDirectory) return { code: 1, stdout: "", stderr: "" };
  const plain: Deno.DirEntry[] = [];
  const dot: Deno.DirEntry[] = [];
  const dotdot: Deno.DirEntry[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.name.startsWith(".")) plain.push(e);
      else if (e.name[1] !== ".") dot.push(e);
      else if (e.name.length > 2) dotdot.push(e);
    }
  } catch {
    // An unreadable folder: every glob stays unmatched and `test -d` still succeeds.
    return { code: 0, stdout: "", stderr: "" };
  }
  const out: string[] = [];
  let n = 0;
  for (const group of [plain, dot, dotdot]) {
    group.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of group) {
      if (e.name === ".git") continue;
      let isDir = e.isDirectory;
      if (e.isSymlink) isDir = (await Deno.stat(join(dir, e.name)).catch(() => null))?.isDirectory ?? false;
      out.push(isDir ? "d" : "f", e.name);
      if (++n >= LISTING_MAX_ENTRIES) return { code: 0, stdout: out.join("\0") + "\0", stderr: "" };
    }
  }
  return { code: 0, stdout: out.length ? out.join("\0") + "\0" : "", stderr: "" };
}
