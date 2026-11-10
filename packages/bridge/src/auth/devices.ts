/**
 * Paired devices (DESIGN.md §4 "Device pairing"): `<state>/devices.json` (0600) holds one record per device,
 * `{id, name, scope, created}` plus the SHA-256 of its cookie secret (the secret itself is only ever in the device's
 * httpOnly cookie). The bridge adds records when a code is redeemed; `herdr-relay revoke` removes them. Both write
 * through an exclusive lock file and an atomic rename, so neither loses the other's change; the bridge notices a
 * changed file by its `stat` before every lookup.
 *
 * Schema version: the file's `v` ({@link DEVICES_VERSION}, OSS-PLAN §5 upgrade path). A file with a higher `v` was
 * written by a newer herdr-relay: it is refused with a message saying so (the bridge then pairs no device) and never
 * rewritten, so a downgrade cannot destroy it.
 */

import type { Scope } from "@herdr-relay/protocol";
import { base64url, hex, randomBytes, sameSecret, sha256Hex } from "./secret.ts";

export const DEVICES_FILE = "devices.json";
/** The `v` this herdr-relay reads and writes. */
export const DEVICES_VERSION = 1;
const LOCK_FILE = "devices.lock";
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const NAME_MAX = 64;

/** What a session knows about the device it serves. */
export interface DeviceIdentity {
  id: string;
  name: string;
  scope: Scope;
}

/** One paired device as stored in devices.json. */
export interface DeviceRecord extends DeviceIdentity {
  /** ISO 8601. */
  created: string;
  /** SHA-256 (hex) of the cookie secret. */
  secretHash: string;
}

/** The identity of loopback-token clients: the Mac's own user (CLI, mirror mod, simulators), scope `act`. */
export const LOCAL_DEVICE: DeviceIdentity = Object.freeze({ id: "local", name: "loopback", scope: "act" });

export class DeviceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceStoreError";
  }
}

/** A display name: control characters removed, trimmed, at most 64 characters; `null` when nothing is left. */
export function cleanDeviceName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // deno-lint-ignore no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX).trim();
  return name === "" ? null : name;
}

/** The public part of a record (the CLI's `devices` listing and `/api/hello`). */
export function deviceView(d: DeviceIdentity): DeviceIdentity {
  return { id: d.id, name: d.name, scope: d.scope };
}

export class DeviceStore {
  readonly path: string;
  readonly #dir: string;
  #cache: DeviceRecord[] = [];
  #stamp: string | null = null;
  /** Why the last refresh found no usable file (malformed or unreadable); `null` when it read fine. */
  error: string | null = null;

  constructor(stateDir: string) {
    this.#dir = stateDir;
    this.path = `${stateDir}/${DEVICES_FILE}`;
  }

  /** Every record, read from disk now. Throws on a malformed file. */
  async list(): Promise<DeviceRecord[]> {
    return (await this.#read()).devices;
  }

  /**
   * Re-reads devices.json when its inode, mtime or size changed since the last read. Fails closed: an unreadable or
   * malformed file leaves no device paired (and sets `error`).
   */
  async refresh(): Promise<void> {
    let stamp: string;
    try {
      const st = await Deno.stat(this.path);
      stamp = `${st.ino}:${st.mtime?.getTime()}:${st.size}`;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        this.#fail(e);
        return;
      }
      stamp = "absent";
    }
    if (stamp === this.#stamp) return;
    try {
      this.#cache = (await this.#read()).devices;
      this.#stamp = stamp;
      this.error = null;
    } catch (e) {
      this.#fail(e);
    }
  }

  /** Whether `id` was paired at the last `refresh()`. */
  has(id: string): boolean {
    return this.#cache.some((d) => d.id === id);
  }

  /** The device a cookie secret belongs to, after a `refresh()`. */
  async findBySecret(secret: string): Promise<DeviceRecord | null> {
    await this.refresh();
    const hash = await sha256Hex(secret);
    let found: DeviceRecord | null = null;
    for (const d of this.#cache) if (sameSecret(d.secretHash, hash)) found = d;
    return found;
  }

  /** Pairs a new device; returns its record and the cookie secret (shown to nobody but that device). */
  async add(name: string, scope: Scope): Promise<{ device: DeviceRecord; secret: string }> {
    const secret = base64url(randomBytes(32));
    const device: DeviceRecord = {
      id: hex(randomBytes(6)),
      name: cleanDeviceName(name) ?? "device",
      scope,
      created: new Date().toISOString(),
      secretHash: await sha256Hex(secret),
    };
    await this.#locked(async () => {
      const file = await this.#read();
      file.devices.push(device);
      await this.#write(file.devices);
    });
    await this.refresh();
    return { device, secret };
  }

  /** Removes the device with this id, or the only device with this name. */
  async revoke(idOrName: string): Promise<DeviceRecord> {
    const removed = await this.#locked(async () => {
      const { devices } = await this.#read();
      let matches = devices.filter((d) => d.id === idOrName);
      if (matches.length === 0) matches = devices.filter((d) => d.name === idOrName);
      if (matches.length === 0) throw new DeviceStoreError(`no paired device "${idOrName}"`);
      if (matches.length > 1) {
        throw new DeviceStoreError(
          `"${idOrName}" names ${matches.length} devices (${matches.map((d) => d.id).join(", ")}); revoke by id`,
        );
      }
      await this.#write(devices.filter((d) => d !== matches[0]));
      return matches[0];
    });
    await this.refresh();
    return removed;
  }

  #fail(e: unknown): void {
    this.#cache = [];
    this.#stamp = null;
    this.error = e instanceof Error ? e.message : String(e);
  }

  async #read(): Promise<{ devices: DeviceRecord[] }> {
    let text: string;
    try {
      text = await Deno.readTextFile(this.path);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return { devices: [] };
      throw e;
    }
    return { devices: parseDevices(text, this.path) };
  }

  async #write(devices: DeviceRecord[]): Promise<void> {
    const tmp = `${this.path}.${hex(randomBytes(4))}.tmp`;
    const text = `${JSON.stringify({ v: DEVICES_VERSION, devices }, null, 2)}\n`;
    await Deno.writeTextFile(tmp, text, { createNew: true, mode: 0o600 });
    try {
      await Deno.rename(tmp, this.path);
    } catch (e) {
      await Deno.remove(tmp).catch(() => {});
      throw e;
    }
  }

  async #locked<T>(fn: () => Promise<T>): Promise<T> {
    const lock = `${this.#dir}/${LOCK_FILE}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        (await Deno.open(lock, { createNew: true, write: true, mode: 0o600 })).close();
        break;
      } catch (e) {
        if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
      }
      const st = await Deno.stat(lock).catch(() => null);
      if (st?.mtime && Date.now() - st.mtime.getTime() > LOCK_STALE_MS) {
        await Deno.remove(lock).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new DeviceStoreError(`${lock} is held by another herdr-relay process`);
      const wait = Promise.withResolvers<void>();
      setTimeout(wait.resolve, 25);
      await wait.promise;
    }
    try {
      return await fn();
    } finally {
      await Deno.remove(lock).catch(() => {});
    }
  }
}

const ID = /^[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

function parseDevices(text: string, path: string): DeviceRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DeviceStoreError(`${path} is not JSON`);
  }
  const v = typeof data === "object" && data !== null && "v" in data ? data.v : undefined;
  if (typeof v === "number" && Number.isInteger(v) && v > DEVICES_VERSION) {
    throw new DeviceStoreError(
      `${path} has version ${v}, written by a newer herdr-relay (this one reads version ${DEVICES_VERSION}); ` +
        "upgrade herdr-relay, or restore a version 1 backup — the file is left unchanged",
    );
  }
  if (v !== DEVICES_VERSION || typeof data !== "object" || data === null || !("devices" in data)) {
    throw new DeviceStoreError(`${path} is not a v${DEVICES_VERSION} device list`);
  }
  const list = data.devices;
  if (!Array.isArray(list)) throw new DeviceStoreError(`${path} is not a v${DEVICES_VERSION} device list`);
  return list.map((raw: unknown, i): DeviceRecord => {
    const d: Record<string, unknown> = typeof raw === "object" && raw !== null ? { ...raw } : {};
    const { id, name, scope, created, secretHash } = d;
    if (
      typeof id !== "string" || !ID.test(id) || typeof name !== "string" || cleanDeviceName(name) !== name ||
      (scope !== "read" && scope !== "act") || typeof created !== "string" ||
      typeof secretHash !== "string" || !HASH.test(secretHash)
    ) {
      throw new DeviceStoreError(`${path}: device #${i} is malformed`);
    }
    return { id, name, scope, created, secretHash };
  });
}
