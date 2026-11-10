/**
 * Mod `localStorage` persistence (DESIGN-v2 §1.4, §2.6; AMENDMENTS-c1 §T06). `localStorage` is per copy: the host sends
 * a copy's whole map with `storage.set [map]` on every change, and the supervisor restores it in `create.storage`.
 * One file per mod folder, `<state>/storage/<folder>.json` = `{"<copy>": {"<key>": "<value>"}}` (compact JSON, at
 * most 1 MiB; directory 0700, file 0600). Writes are coalesced to at most one per second and replace the file
 * atomically (temp file + rename).
 */

import { dirname, join } from "@std/path";
import { copyBelongsTo, type StorageMap, StorageMapSchema, validate } from "@herdr-relay/protocol";
import { messageOf } from "../core/errors.ts";

/** Largest storage file per folder (all of its copies), in bytes of compact JSON. */
export const STORAGE_MAX_BYTES = 1024 * 1024;
/** A change is written at most this long after it was accepted. */
export const STORAGE_WRITE_DELAY_MS = 1000;

const encoder = new TextEncoder();

/** A `storage.set` the supervisor refuses (over the cap); the message is safe to show on a device. */
export class StorageRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageRefusal";
  }
}

interface Entry {
  map: StorageMap;
  /** UTF-8 bytes of `"<copy>":{…}` in the file. */
  bytes: number;
}

const entryBytes = (copy: string, map: StorageMap) =>
  encoder.encode(`${JSON.stringify(copy)}:${JSON.stringify(map)}`).length;

/** The persisted `localStorage` of one mod folder's copies. */
export class FolderStorage {
  readonly folder: string;
  /** `<state>/storage/<folder>.json`. */
  readonly path: string;
  readonly #log: (message: string) => void;
  readonly #entries = new Map<string, Entry>();
  #entryBytes = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #writing: Promise<void> = Promise.resolve();

  private constructor(stateDir: string, folder: string, log: (message: string) => void) {
    this.folder = folder;
    this.path = join(stateDir, "storage", `${folder}.json`);
    this.#log = log;
  }

  /**
   * Loads the folder's file. A missing file is empty storage; an unreadable, oversized or malformed file is logged
   * and treated as empty (the next write replaces it). Entries for copies of other folders are dropped.
   */
  static async open(stateDir: string, folder: string, log: (message: string) => void): Promise<FolderStorage> {
    const storage = new FolderStorage(stateDir, folder, log);
    let text: string;
    try {
      const info = await Deno.stat(storage.path);
      if (info.size > STORAGE_MAX_BYTES) {
        log(`storage ${folder}: ${storage.path} is over ${STORAGE_MAX_BYTES} bytes; starting empty`);
        return storage;
      }
      text = await Deno.readTextFile(storage.path);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) log(`storage ${folder}: cannot read ${storage.path}: ${messageOf(e)}`);
      return storage;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      log(`storage ${folder}: ${storage.path} is not JSON (${messageOf(e)}); starting empty`);
      return storage;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      log(`storage ${folder}: ${storage.path} is not an object; starting empty`);
      return storage;
    }
    for (const [copy, map] of Object.entries(data)) {
      const v = validate(StorageMapSchema, map);
      if (!copyBelongsTo(copy, folder) || !v.ok) {
        log(`storage ${folder}: dropped entry ${JSON.stringify(copy)}`);
        continue;
      }
      storage.#put(copy, v.value);
    }
    return storage;
  }

  /** Bytes of the file as it would be written now. */
  get bytes(): number {
    return 2 + this.#entryBytes + Math.max(0, this.#entries.size - 1);
  }

  /** The copy's persisted map, or undefined when it has none. */
  get(copy: string): StorageMap | undefined {
    return this.#entries.get(copy)?.map;
  }

  /**
   * Replaces the copy's map (an empty map removes it) and schedules a write. Throws `StorageRefusal` when the file
   * would exceed `STORAGE_MAX_BYTES`; nothing changes then.
   */
  set(copy: string, map: StorageMap): void {
    if (!copyBelongsTo(copy, this.folder)) throw new StorageRefusal(`${copy} is not a copy of ${this.folder}`);
    const old = this.#entries.get(copy);
    const empty = Object.keys(map).length === 0;
    const bytes = empty ? 0 : entryBytes(copy, map);
    const count = this.#entries.size - (old ? 1 : 0) + (empty ? 0 : 1);
    const total = 2 + this.#entryBytes - (old?.bytes ?? 0) + bytes + Math.max(0, count - 1);
    if (total > STORAGE_MAX_BYTES) {
      throw new StorageRefusal(`localStorage of ${this.folder} would be ${total} bytes, over the 1 MiB limit`);
    }
    if (old) {
      this.#entries.delete(copy);
      this.#entryBytes -= old.bytes;
    }
    if (!empty) this.#put(copy, { ...map }, bytes);
    this.#schedule();
  }

  /** Writes pending changes now. */
  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#write();
    }
    await this.#writing;
  }

  #put(copy: string, map: StorageMap, bytes = entryBytes(copy, map)): void {
    this.#entries.set(copy, { map, bytes });
    this.#entryBytes += bytes;
  }

  #schedule(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#write();
    }, STORAGE_WRITE_DELAY_MS);
  }

  #write(): void {
    const text = JSON.stringify(Object.fromEntries([...this.#entries].map(([copy, e]) => [copy, e.map])));
    this.#writing = this.#writing.then(async () => {
      const tmp = `${this.path}.tmp`;
      try {
        await Deno.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await Deno.writeTextFile(tmp, text, { mode: 0o600 });
        await Deno.rename(tmp, this.path);
      } catch (e) {
        this.#log(`storage ${this.folder}: cannot write ${this.path}: ${messageOf(e)}`);
      }
    });
  }
}
