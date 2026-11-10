/**
 * Path containment and real-path helpers shared by the read, exec and symlink policies (DESIGN-v2 §2.1–§2.2).
 * Every path argument from a mod is checked lexically first and then again after `realPath`; only the real path is
 * trusted. Migrated from the Deno spike's `within` (`docs/spikes/deno.md`).
 */

import { dirname, isAbsolute, join, normalize, relative, resolve, SEPARATOR } from "@std/path";

/** Whether `p` is `root` or inside it. Both must be absolute and normalized (no trailing separator except "/"). */
export function within(p: string, root: string): boolean {
  if (root === SEPARATOR) return p.startsWith(SEPARATOR);
  return p === root || p.startsWith(root + SEPARATOR);
}

/** `p` made absolute against `base` and normalized, without touching the file system. */
export function lexical(p: string, base: string): string {
  const abs = isAbsolute(p) ? normalize(p) : resolve(base, p);
  return abs.length > 1 && abs.endsWith(SEPARATOR) ? abs.slice(0, -1) : abs;
}

/** `Deno.realPath`, or null when the path does not exist (dangling links included). Other errors propagate. */
export async function realPathOrNull(p: string): Promise<string | null> {
  try {
    return await Deno.realPath(p);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

/**
 * The real path of `p` when it exists; otherwise the real path of its deepest existing ancestor joined with the rest
 * of the lexical path, and `exists: false`. Used for destinations that are about to be created (a picture) and to
 * tell "missing inside the roots" (Herdr returns null) from "missing below a link that leaves them" (refused).
 */
export async function resolveReal(p: string): Promise<{ real: string; exists: boolean }> {
  const abs = normalize(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    const real = await realPathOrNull(cur);
    if (real !== null) return { real: tail.length ? join(real, ...tail.reverse()) : real, exists: tail.length === 0 };
    const parent = dirname(cur);
    if (parent === cur) return { real: abs, exists: false };
    tail.push(cur.slice(parent === SEPARATOR ? 1 : parent.length + 1));
    cur = parent;
  }
}

/** `p` relative to `root` with `/` separators, or null when `p` is not inside `root`. */
export function relativeInside(p: string, root: string): string | null {
  if (!within(p, root)) return null;
  return p === root ? "" : relative(root, p);
}
