/**
 * Device layout profiles (D12, DESIGN.md §3 "Device layout profile"): the sizes one paired device keeps for the nodes
 * it may resize (`overridable()`), per layout name and device class, applied with `applyProfile()` after the Mac's
 * layout file and clicks and before session-transient clicks. Never written to the Mac.
 *
 * One file per device, `<state>/layout-profiles/<device id>.json` =
 * `{"v":1,"layouts":{"<layout>":{"<class>":{"<node id>":{"px"?,"weight"?,"collapsed"?}}}}}` (compact JSON, at most
 * {@link LAYOUT_PROFILE_MAX_BYTES}; directory 0700, file 0600). The loopback identity's file is `local.json`. Writes
 * are coalesced to at most one per second per device and replace the file atomically (a new temp file with a random
 * name, created exclusively, then renamed over it); a profile left empty removes its file. A missing file is an empty
 * profile; an unreadable, oversized or malformed one is logged once and treated as empty (the next write replaces it);
 * a malformed section is dropped (logged once per file). Layout names and node ids are data, never object keys a
 * prototype could swallow (`__proto__` round-trips and counts against the cap).
 *
 * Containment: the profile directory must be a real directory directly in the state directory (not a symlink, its
 * real path `<real state>/layout-profiles`), checked when the store opens and before every write or delete; otherwise
 * nothing is read or written there (logged once per reason; profiles stay in memory). A profile file that is a symlink
 * or not a regular file is never followed: it reads as empty (logged) and the next write replaces the link itself.
 *
 * Layouts are kept least recently changed first (the file keeps that order). A change that would take the file over
 * the cap drops whole layouts, oldest first, never the one being changed; when that one alone is over the cap the
 * change is refused ({@link ProfileRefusal}). Entries are otherwise dropped only by a reset and by {@link remove} /
 * {@link retain} (a device confirmed no longer paired).
 */

import { join } from "@std/path";
import {
  DEVICE_CLASSES,
  type DeviceClass,
  type LayoutProfileSection,
  LayoutProfileSectionSchema,
  validate,
} from "@herdr-relay/protocol";
import { hex, randomBytes } from "../auth/secret.ts";
import { messageOf } from "../core/errors.ts";

/** The directory under the state directory. */
export const LAYOUT_PROFILE_DIR = "layout-profiles";
/** The file's `v`. */
export const LAYOUT_PROFILE_VERSION = 1;
/** Largest profile file per device, in bytes of compact JSON. */
export const LAYOUT_PROFILE_MAX_BYTES = 64 * 1024;
/** A change is written at most this long after it was accepted. */
export const LAYOUT_PROFILE_WRITE_DELAY_MS = 1000;

/** Device ids that name a file (paired ids are 12 hex digits; the loopback identity is `local`). */
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CLASSES: ReadonlySet<string> = new Set(DEVICE_CLASSES);
const encoder = new TextEncoder();

/** A profile change the store refuses (over the cap); the message is safe to show on a device. */
export class ProfileRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileRefusal";
  }
}

/** One device's profile as its sessions use it ({@link LayoutProfileStore.device}). */
export interface DeviceProfile {
  /** A copy of the section for this layout and class (empty when there is none). */
  section(layout: string, device: DeviceClass): LayoutProfileSection;
  /** Replaces the section (empty removes it); throws {@link ProfileRefusal} when it cannot fit. */
  put(layout: string, device: DeviceClass, section: LayoutProfileSection): void;
}

/** Layout name → class → section, least recently changed layout first. */
type Layouts = Map<string, Map<DeviceClass, LayoutProfileSection>>;

/** The file's text. `Object.fromEntries` defines own keys, so a layout named `__proto__` is kept like any other. */
function serialize(layouts: Layouts): string {
  const out = Object.fromEntries([...layouts].map(([name, classes]) => [name, Object.fromEntries(classes)]));
  return JSON.stringify({ v: LAYOUT_PROFILE_VERSION, layouts: out });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every device's layout profile, in memory, written behind to `<state>/layout-profiles/`. */
export class LayoutProfileStore {
  /** `<state>/layout-profiles`, or `null`: kept in memory only. */
  readonly dir: string | null;
  readonly #stateDir: string | null;
  readonly #log: (line: string) => void;
  readonly #devices = new Map<string, Layouts>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Containment refusals already logged. */
  readonly #refusals = new Set<string>();
  #writing: Promise<void> = Promise.resolve();

  private constructor(stateDir: string | null, log: (line: string) => void) {
    this.#stateDir = stateDir;
    this.dir = stateDir === null ? null : join(stateDir, LAYOUT_PROFILE_DIR);
    this.#log = log;
  }

  /** A store that keeps profiles for this run only (no state directory). */
  static memory(): LayoutProfileStore {
    return new LayoutProfileStore(null, () => {});
  }

  /**
   * Loads every profile file of `<stateDir>/layout-profiles`; a missing directory is no profiles, one that fails the
   * containment check is not read (logged).
   */
  static async open(stateDir: string, log: (line: string) => void): Promise<LayoutProfileStore> {
    const store = new LayoutProfileStore(stateDir, log);
    const dir = store.dir!;
    if (!(await store.#contained(true))) return store;
    const ids: string[] = [];
    try {
      for await (const e of Deno.readDir(dir)) {
        // Symlinks are listed so that reading them logs that they are not followed.
        const id = (e.isFile || e.isSymlink) && e.name.endsWith(".json") ? e.name.slice(0, -".json".length) : "";
        if (FILE_ID.test(id)) ids.push(id);
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) log(`cannot read ${dir}: ${messageOf(e)}`);
      return store;
    }
    for (const id of ids.sort()) store.#devices.set(id, await store.#read(id));
    return store;
  }

  /** Device ids with a profile (in memory or on disk). */
  get devices(): string[] {
    return [...this.#devices.keys()];
  }

  /** `<dir>/<id>.json`, or `null` when the profile is not written (memory store, an id unfit for a file name). */
  pathOf(id: string): string | null {
    return this.dir !== null && FILE_ID.test(id) ? join(this.dir, `${id}.json`) : null;
  }

  /** Bytes of device `id`'s file as it would be written now (0 without a profile). */
  bytes(id: string): number {
    const layouts = this.#devices.get(id);
    return layouts && layouts.size > 0 ? encoder.encode(serialize(layouts)).length : 0;
  }

  /** Device `id`'s profile, bound for its sessions. */
  device(id: string): DeviceProfile {
    return {
      section: (layout, device) => this.section(id, layout, device),
      put: (layout, device, section) => this.put(id, layout, device, section),
    };
  }

  /** A copy of device `id`'s section for this layout and class (empty when there is none). */
  section(id: string, layout: string, device: DeviceClass): LayoutProfileSection {
    const section = this.#devices.get(id)?.get(layout)?.get(device);
    return section ? structuredClone(section) : {};
  }

  /**
   * Replaces device `id`'s section for this layout and class (an empty section removes it), makes the layout the most
   * recently changed one and schedules a write. Over {@link LAYOUT_PROFILE_MAX_BYTES} the oldest other layouts are
   * dropped first; throws {@link ProfileRefusal} when the layout alone does not fit (nothing changes then).
   */
  put(id: string, layout: string, device: DeviceClass, section: LayoutProfileSection): void {
    const next: Layouts = new Map(this.#devices.get(id));
    const classes = new Map(next.get(layout));
    next.delete(layout);
    if (Object.keys(section).length === 0) classes.delete(device);
    else classes.set(device, structuredClone(section));
    if (classes.size > 0) next.set(layout, classes);
    const dropped: string[] = [];
    let bytes = next.size > 0 ? encoder.encode(serialize(next)).length : 0;
    while (bytes > LAYOUT_PROFILE_MAX_BYTES) {
      const oldest = [...next.keys()].find((name) => name !== layout);
      if (oldest === undefined) {
        throw new ProfileRefusal(
          `the layout profile of ${JSON.stringify(layout)} would be ${bytes} bytes, over the 64 KiB limit`,
        );
      }
      next.delete(oldest);
      dropped.push(oldest);
      bytes = encoder.encode(serialize(next)).length;
    }
    for (const name of dropped) {
      this.#log(`${id}: profile over ${LAYOUT_PROFILE_MAX_BYTES} bytes; dropped layout ${JSON.stringify(name)}`);
    }
    if (next.size > 0) this.#devices.set(id, next);
    else this.#devices.delete(id);
    this.#schedule(id);
  }

  /**
   * Forgets device `id`'s profile and deletes its file now. Only for a device confirmed no longer paired (a successful
   * read of the device list): a revocation decided while the list is unreadable must not lose it.
   */
  remove(id: string): void {
    this.#devices.delete(id);
    clearTimeout(this.#timers.get(id));
    this.#timers.delete(id);
    this.#write(id);
  }

  /**
   * Removes the profile of every device `paired` does not name (the caller keeps the loopback identity, and calls this
   * only after a successful read of the device list).
   */
  retain(paired: (id: string) => boolean): void {
    for (const id of [...this.#devices.keys()]) {
      if (paired(id)) continue;
      this.#log(`${id}: no longer paired; layout profile removed`);
      this.remove(id);
    }
  }

  /** Writes pending changes now. */
  async flush(): Promise<void> {
    for (const [id, timer] of [...this.#timers]) {
      clearTimeout(timer);
      this.#timers.delete(id);
      this.#write(id);
    }
    await this.#writing;
  }

  /**
   * Whether the profile directory is a real directory whose real path is `<real state dir>/layout-profiles`. A missing
   * one passes only when `absentOk` (nothing to read yet); a failure is logged once per reason.
   */
  async #contained(absentOk = false): Promise<boolean> {
    const dir = this.dir!;
    let reason: string;
    try {
      const info = await Deno.lstat(dir);
      if (info.isSymlink) reason = `${dir} is a symlink`;
      else if (!info.isDirectory) reason = `${dir} is not a directory`;
      else {
        const [real, state] = await Promise.all([Deno.realPath(dir), Deno.realPath(this.#stateDir!)]);
        if (real === join(state, LAYOUT_PROFILE_DIR)) return true;
        reason = `${dir} resolves to ${real}, outside ${state}`;
      }
    } catch (e) {
      if (e instanceof Deno.errors.NotFound && absentOk) return true;
      reason = `cannot check ${dir}: ${messageOf(e)}`;
    }
    if (!this.#refusals.has(reason)) {
      this.#refusals.add(reason);
      this.#log(`${reason}; layout profiles are not read or written there`);
    }
    return false;
  }

  /** Device `id`'s file; empty (and logged once) when it is unreadable, oversized, malformed or not a regular file. */
  async #read(id: string): Promise<Layouts> {
    const layouts: Layouts = new Map();
    const path = this.pathOf(id)!;
    let text: string;
    try {
      const info = await Deno.lstat(path);
      if (info.isSymlink || !info.isFile) {
        this.#log(`${id}: ${path} is ${info.isSymlink ? "a symlink" : "not a file"}; not followed, starting empty`);
        return layouts;
      }
      if (info.size > LAYOUT_PROFILE_MAX_BYTES) {
        this.#log(`${id}: ${path} is over ${LAYOUT_PROFILE_MAX_BYTES} bytes; starting empty`);
        return layouts;
      }
      text = await Deno.readTextFile(path);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) this.#log(`${id}: cannot read ${path}: ${messageOf(e)}`);
      return layouts;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      this.#log(`${id}: ${path} is not JSON (${messageOf(e)}); starting empty`);
      return layouts;
    }
    if (!isObject(data) || data.v !== LAYOUT_PROFILE_VERSION || !isObject(data.layouts)) {
      this.#log(`${id}: ${path} is not a v${LAYOUT_PROFILE_VERSION} layout profile; starting empty`);
      return layouts;
    }
    let dropped = 0;
    for (const [name, raw] of Object.entries(data.layouts)) {
      if (!isObject(raw)) {
        dropped++;
        continue;
      }
      const classes = new Map<DeviceClass, LayoutProfileSection>();
      for (const [device, section] of Object.entries(raw)) {
        const v = validate(LayoutProfileSectionSchema, section);
        if (!CLASSES.has(device) || !v.ok) dropped++;
        else if (Object.keys(v.value).length > 0) classes.set(device as DeviceClass, v.value);
      }
      if (classes.size > 0) layouts.set(name, classes);
    }
    if (dropped > 0) this.#log(`${id}: dropped ${dropped} malformed section(s) of ${path}`);
    return layouts;
  }

  #schedule(id: string): void {
    if (this.#timers.has(id) || this.pathOf(id) === null) return;
    this.#timers.set(
      id,
      setTimeout(() => {
        this.#timers.delete(id);
        this.#write(id);
      }, LAYOUT_PROFILE_WRITE_DELAY_MS),
    );
  }

  /**
   * Queues writing device `id`'s file as it is now — a new exclusive temp file renamed over it (a symlink there is
   * replaced, never followed) — or deleting it when the profile is empty; only while the directory is contained.
   */
  #write(id: string): void {
    const path = this.pathOf(id);
    if (path === null) return;
    const layouts = this.#devices.get(id);
    const text = layouts && layouts.size > 0 ? serialize(layouts) : null;
    this.#writing = this.#writing.then(async () => {
      try {
        if (text === null) {
          if (!(await this.#contained(true))) return;
          await Deno.remove(path).catch((e) => {
            if (!(e instanceof Deno.errors.NotFound)) throw e;
          });
          return;
        }
        await Deno.mkdir(this.dir!, { recursive: true, mode: 0o700 });
        if (!(await this.#contained())) return;
        const tmp = `${path}.${hex(randomBytes(4))}.tmp`;
        await Deno.writeTextFile(tmp, text, { createNew: true, mode: 0o600 });
        try {
          await Deno.rename(tmp, path);
        } catch (e) {
          await Deno.remove(tmp).catch(() => {});
          throw e;
        }
      } catch (e) {
        this.#log(`${id}: cannot write ${path}: ${messageOf(e)}`);
      }
    });
  }
}
