/**
 * Push state in `<state>` (DESIGN-v2 §1.4; 0600 files in the 0700 directory): the VAPID key pair in `vapid.json`,
 * made on first use, and the devices' push subscriptions in `push.json`.
 */

import { base64url, hex, randomBytes } from "../auth/secret.ts";
import { decodeSubscriptionKeys, fromBase64url, isAllowedEndpoint, type VapidKeys } from "./webpush.ts";

export const VAPID_FILE = "vapid.json";
export const PUSH_FILE = "push.json";
/** Subscriptions kept; the oldest goes first. */
export const MAX_SUBSCRIPTIONS = 32;
/** Longest endpoint URL accepted. */
export const MAX_ENDPOINT_LENGTH = 2048;

/** `vapid.json`. The private key never leaves the bridge; devices get `publicKey` (`GET /push/key`). */
interface VapidFile {
  v: 1;
  /** Raw uncompressed P-256 public key, base64url. */
  publicKey: string;
  privateJwk: JsonWebKey;
}

/** One device's subscription in `push.json`. */
export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Device id (`devices.json`, or `local` for loopback clients). */
  device: string;
  /** `Date.now()` when it was (re)subscribed. */
  at: number;
}

/** Reads `<state>/vapid.json`, creating the key pair on first use (0600, never overwritten). */
export async function ensureVapidKeys(stateDir: string): Promise<VapidKeys> {
  const path = `${stateDir}/${VAPID_FILE}`;
  for (;;) {
    try {
      const text = await Deno.readTextFile(path);
      await Deno.chmod(path, 0o600);
      return await parseVapid(text, path);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const file: VapidFile = {
      v: 1,
      publicKey: base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
      privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    };
    try {
      await Deno.writeTextFile(path, `${JSON.stringify(file, null, 2)}\n`, { createNew: true, mode: 0o600 });
    } catch (e) {
      if (e instanceof Deno.errors.AlreadyExists) continue; // another bridge made it first: use theirs
      throw e;
    }
    return { publicKey: file.publicKey, privateKey: await signingKey(file.privateJwk) };
  }
}

async function parseVapid(text: string, path: string): Promise<VapidKeys> {
  const broken = () => new Error(`${path} is not a herdr-relay VAPID key; remove it to make a new one`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw broken();
  }
  const file = recordOf(data);
  const jwk = recordOf(file?.privateJwk);
  if (
    file?.v !== 1 || typeof file.publicKey !== "string" || jwk?.kty !== "EC" || jwk.crv !== "P-256" ||
    typeof jwk.d !== "string" || typeof jwk.x !== "string" || typeof jwk.y !== "string"
  ) throw broken();
  const { publicKey } = file;
  try {
    const point = fromBase64url(publicKey);
    if (point.length !== 65 || point[0] !== 4) throw broken();
    if (base64url(point.subarray(1, 33)) !== jwk.x || base64url(point.subarray(33)) !== jwk.y) throw broken();
    return { publicKey, privateKey: await signingKey({ kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y }) };
  } catch {
    throw broken();
  }
}

/** `value` as a plain object, or null. */
function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : null;
}

function signingKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** Whether a subscription may be kept: an allowed push service and well-formed keys. */
export function subscriptionProblem(endpoint: string, keys: { p256dh: string; auth: string }): string | null {
  if (endpoint.length > MAX_ENDPOINT_LENGTH || !isAllowedEndpoint(endpoint)) return "unsupported push service";
  try {
    decodeSubscriptionKeys(keys);
  } catch {
    return "invalid push subscription keys";
  }
  return null;
}

/** `<state>/push.json`: written whole (temporary file + rename), one write at a time. */
export class SubscriptionStore {
  readonly path: string;
  #subscriptions: StoredSubscription[] = [];
  #loaded: Promise<void> | null = null;
  #writes: Promise<void> = Promise.resolve();
  readonly #log: (line: string) => void;

  constructor(stateDir: string, log: (line: string) => void) {
    this.path = `${stateDir}/${PUSH_FILE}`;
    this.#log = log;
  }

  /** The subscriptions, after {@link load}. */
  get list(): readonly StoredSubscription[] {
    return this.#subscriptions;
  }

  /**
   * Reads the file once. Entries that are malformed, for another push service, or over the cap are dropped (and
   * logged); an unreadable file is an error, a malformed one counts as empty.
   */
  load(): Promise<void> {
    this.#loaded ??= this.#read();
    return this.#loaded;
  }

  /** Adds or replaces (same endpoint) a subscription; the oldest go beyond {@link MAX_SUBSCRIPTIONS}. */
  async add(subscription: StoredSubscription): Promise<void> {
    await this.load();
    this.#subscriptions = [
      ...this.#subscriptions.filter((s) => s.endpoint !== subscription.endpoint),
      subscription,
    ].slice(-MAX_SUBSCRIPTIONS);
    await this.#save();
  }

  /** Forgets these endpoints (gone at the push service, revoked device, …). */
  async remove(endpoints: Iterable<string>): Promise<void> {
    await this.load();
    const gone = new Set(endpoints);
    const kept = this.#subscriptions.filter((s) => !gone.has(s.endpoint));
    if (kept.length === this.#subscriptions.length) return;
    this.#subscriptions = kept;
    await this.#save();
  }

  async #read(): Promise<void> {
    let text: string;
    try {
      text = await Deno.readTextFile(this.path);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return;
      throw e;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      this.#log(`${this.path} is not JSON; starting with no push subscriptions`);
      return;
    }
    const file = recordOf(data);
    const list = file?.subscriptions;
    if (file?.v !== 1 || !Array.isArray(list)) {
      this.#log(`${this.path} is not a v1 subscription list; starting with no push subscriptions`);
      return;
    }
    const kept: StoredSubscription[] = [];
    for (const raw of list) {
      const s = recordOf(raw);
      const keys = recordOf(s?.keys);
      if (
        typeof s?.endpoint === "string" && typeof keys?.p256dh === "string" && typeof keys.auth === "string" &&
        typeof s.device === "string" && typeof s.at === "number"
      ) {
        const entry = {
          endpoint: s.endpoint,
          keys: { p256dh: keys.p256dh, auth: keys.auth },
          device: s.device,
          at: s.at,
        };
        if (subscriptionProblem(entry.endpoint, entry.keys) === null) kept.push(entry);
      }
    }
    if (kept.length !== list.length) this.#log(`${this.path}: dropped ${list.length - kept.length} unusable entries`);
    this.#subscriptions = kept.slice(-MAX_SUBSCRIPTIONS);
  }

  #save(): Promise<void> {
    const text = `${JSON.stringify({ v: 1, subscriptions: this.#subscriptions }, null, 2)}\n`;
    const write = this.#writes.then(async () => {
      const tmp = `${this.path}.${hex(randomBytes(4))}.tmp`;
      await Deno.writeTextFile(tmp, text, { createNew: true, mode: 0o600 });
      try {
        await Deno.rename(tmp, this.path);
      } catch (e) {
        await Deno.remove(tmp).catch(() => {});
        throw e;
      }
    });
    this.#writes = write.catch(() => {});
    return write;
  }
}
