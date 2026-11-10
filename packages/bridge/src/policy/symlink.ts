/**
 * Load-time symlink audit (DESIGN-v2 §2.2): a mod folder containing a link whose real path leaves the folder's real
 * path, or a dangling link, does not start. Deno's path permissions do not resolve links (spike [M]), so this audit
 * and Seatbelt (which checks the resolved path in the kernel) close the class. Migrated from the Deno spike's
 * `symlinkAudit` (`docs/spikes/deno.md`); links are never followed during the walk, so cycles cannot occur.
 */

import { join, relative } from "@std/path";
import { realPathOrNull, within } from "./paths.ts";

export interface EscapingLink {
  /** Path of the link relative to the folder (`/`-separated). */
  path: string;
  /** Where it resolves, or null when it dangles. */
  target: string | null;
}

/** Every link under `dir` that resolves outside `dir`'s real path or dangles, in walk order. */
export async function symlinkAudit(dir: string): Promise<EscapingLink[]> {
  const root = await Deno.realPath(dir);
  const found: EscapingLink[] = [];
  const walk = async (d: string): Promise<void> => {
    const entries: Deno.DirEntry[] = [];
    for await (const e of Deno.readDir(d)) entries.push(e);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isSymlink) {
        const target = await realPathOrNull(p);
        if (target === null || !within(target, root)) found.push({ path: relative(root, p), target });
      } else if (e.isDirectory) {
        await walk(p);
      }
    }
  };
  await walk(root);
  return found;
}

/** The block text for a folder the audit refused (DESIGN-v2 §2.2). */
export function symlinkAuditMessage(links: readonly EscapingLink[]): string {
  return `mod folder contains a link outside itself: ${links.map((l) => l.path).join(", ")}`;
}
