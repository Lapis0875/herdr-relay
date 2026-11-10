/**
 * `herdr.watchFolder(path)` (DESIGN-v2 §2.1, §4 T09): resolves with the absolute paths that changed under a folder, in
 * batches. One `Deno.watchFs` per (mod folder, real folder), at most {@link MAX_WATCHES_PER_FOLDER} per mod folder;
 * events are batched for {@link WATCH_DEBOUNCE_MS}. Changes that arrive while no call waits are kept for the next one
 * (bounded: past {@link MAX_PENDING_PATHS} the batch is just the folder, which Herdr defines as "refresh
 * everything"). Paths are real paths, as Herdr reports them on macOS (`/private/tmp/…`). The caller has already
 * checked the folder against the read roots.
 */

import { refuse } from "../policy/mod.ts";

export const MAX_WATCHES_PER_FOLDER = 16;
export const WATCH_DEBOUNCE_MS = 100;
/** A watch no call has waited on for this long is closed. */
export const WATCH_IDLE_MS = 60_000;
export const MAX_PENDING_PATHS = 1000;

interface Waiter {
  generation: number;
  resolve(paths: string[]): void;
  reject(error: Error): void;
}

interface Watch {
  readonly dir: string;
  readonly watcher: Deno.FsWatcher;
  waiters: Waiter[];
  pending: Set<string>;
  overflow: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  idle: ReturnType<typeof setTimeout> | undefined;
}

export class FolderWatches {
  readonly #folders = new Map<string, Map<string, Watch>>();
  readonly #log: (line: string) => void;

  constructor(log: (line: string) => void) {
    this.#log = log;
  }

  /** The next batch of changed paths under `dir` (a real folder path) for a call from `folder`'s host `generation`. */
  wait(folder: string, generation: number, dir: string): Promise<string[]> {
    let watches = this.#folders.get(folder);
    if (!watches) this.#folders.set(folder, watches = new Map());
    for (const w of watches.values()) {
      const stale = w.waiters.filter((x) => x.generation < generation);
      if (stale.length === 0) continue;
      w.waiters = w.waiters.filter((x) => x.generation >= generation);
      for (const x of stale) x.reject(new Error("the mod host restarted"));
      if (w.waiters.length === 0) this.#idle(folder, w);
    }
    let w = watches.get(dir);
    if (!w) {
      if (watches.size >= MAX_WATCHES_PER_FOLDER) {
        const idle = [...watches.values()].find((x) => x.waiters.length === 0);
        if (!idle) refuse("read", `a mod may watch at most ${MAX_WATCHES_PER_FOLDER} folders`);
        this.#close(folder, idle);
      }
      w = this.#open(folder, dir);
    }
    clearTimeout(w.idle);
    w.idle = undefined;
    const { promise, resolve, reject } = Promise.withResolvers<string[]>();
    w.waiters.push({ generation, resolve, reject });
    if ((w.pending.size > 0 || w.overflow) && w.timer === undefined) this.#flush(folder, w);
    return promise;
  }

  /** Closes every watch (bridge shutdown); waiting calls are rejected. */
  close(): void {
    for (const [folder, watches] of this.#folders) {
      for (const w of [...watches.values()]) this.#close(folder, w, "the bridge is stopping");
    }
  }

  #open(folder: string, dir: string): Watch {
    const watcher = Deno.watchFs(dir, { recursive: true });
    const w: Watch = {
      dir,
      watcher,
      waiters: [],
      pending: new Set(),
      overflow: false,
      timer: undefined,
      idle: undefined,
    };
    this.#folders.get(folder)!.set(dir, w);
    const prefix = dir === "/" ? "/" : `${dir}/`;
    (async () => {
      try {
        for await (const ev of watcher) {
          if (ev.kind === "access") continue;
          for (const p of ev.paths) {
            if (p !== dir && !p.startsWith(prefix)) continue;
            if (w.pending.size >= MAX_PENDING_PATHS) w.overflow = true;
            else w.pending.add(p);
          }
          clearTimeout(w.timer);
          w.timer = setTimeout(() => {
            w.timer = undefined;
            if (w.waiters.length) this.#flush(folder, w);
          }, WATCH_DEBOUNCE_MS);
        }
        this.#close(folder, w, `stopped watching ${dir}`);
      } catch (e) {
        if (e instanceof Deno.errors.BadResource) return;
        this.#log(`watchFolder ${dir}: ${e instanceof Error ? e.message : String(e)}`);
        this.#close(folder, w, `stopped watching ${dir}`);
      }
    })();
    return w;
  }

  #flush(folder: string, w: Watch): void {
    const batch = w.overflow ? [w.dir] : [...w.pending];
    w.pending.clear();
    w.overflow = false;
    const waiters = w.waiters;
    w.waiters = [];
    for (const x of waiters) x.resolve(batch);
    this.#idle(folder, w);
  }

  #idle(folder: string, w: Watch): void {
    clearTimeout(w.idle);
    w.idle = setTimeout(() => this.#close(folder, w), WATCH_IDLE_MS);
  }

  #close(folder: string, w: Watch, why?: string): void {
    const watches = this.#folders.get(folder);
    if (watches?.get(w.dir) !== w) return;
    watches.delete(w.dir);
    if (watches.size === 0) this.#folders.delete(folder);
    clearTimeout(w.timer);
    clearTimeout(w.idle);
    try {
      w.watcher.close();
    } catch {
      // already closed
    }
    for (const x of w.waiters) x.reject(new Error(why ?? `stopped watching ${w.dir}`));
    w.waiters = [];
  }
}
