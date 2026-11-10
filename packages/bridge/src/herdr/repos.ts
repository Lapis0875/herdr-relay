/**
 * The git repository and branch of a terminal's live folder, for `spaces()[i].branch`, `panes()[i].branch` and a
 * space's automatic name (AGENTS.md "The model": "its repo, else its folder"). Read from `.git/HEAD` (worktrees: the
 * `gitdir:` a `.git` file names) without running git; looked up in the background and cached, so building the model
 * stays synchronous. A changed answer calls `changed`.
 */

import { basename, dirname, isAbsolute, join, resolve } from "@std/path";

export interface RepoInfo {
  /** The repository's top folder. */
  root: string;
  /** The checked-out branch; null when detached or unreadable. */
  branch: string | null;
}

/** A cached answer is looked up again when read after this long. */
export const REPO_TTL_MS = 5_000;
/** Folders remembered at most. */
const MAX_ENTRIES = 256;

interface Entry {
  info: RepoInfo | null;
  at: number;
  pending: boolean;
}

export class RepoCache {
  readonly #changed: () => void;
  readonly #entries = new Map<string, Entry>();

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  /** The repo of `cwd` as last looked up (null: none, or not looked up yet); refreshes in the background. */
  get(cwd: string): RepoInfo | null {
    let e = this.#entries.get(cwd);
    if (!e) {
      if (this.#entries.size >= MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value!);
      e = { info: null, at: 0, pending: false };
      this.#entries.set(cwd, e);
    }
    if (!e.pending && Date.now() - e.at > REPO_TTL_MS) {
      e.pending = true;
      const entry = e;
      lookup(cwd).then((info) => {
        entry.pending = false;
        entry.at = Date.now();
        const same = entry.info?.root === info?.root && entry.info?.branch === info?.branch;
        entry.info = info;
        if (!same) this.#changed();
      });
    }
    return e.info;
  }
}

/** The name a space without one gets from its first terminal's folder: the repo, else the folder, `~` at home. */
export function folderName(cwd: string, repo: RepoInfo | null, home: string): string {
  if (repo) return basename(repo.root);
  if (cwd === home) return "~";
  return basename(cwd) || cwd;
}

async function lookup(cwd: string): Promise<RepoInfo | null> {
  if (!isAbsolute(cwd)) return null;
  let dir = cwd;
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = join(dir, ".git");
    const st = await Deno.lstat(dotGit).catch(() => null);
    if (st) {
      const gitDir = st.isDirectory ? dotGit : st.isFile ? await gitDirFile(dotGit, dir) : null;
      if (gitDir) return { root: dir, branch: await branchOf(gitDir) };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

async function gitDirFile(file: string, dir: string): Promise<string | null> {
  const text = await Deno.readTextFile(file).catch(() => "");
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  return m ? resolve(dir, m[1].trim()) : null;
}

async function branchOf(gitDir: string): Promise<string | null> {
  const head = await Deno.readTextFile(join(gitDir, "HEAD")).catch(() => "");
  const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  return m ? m[1].trim() : null;
}
