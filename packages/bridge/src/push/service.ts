/**
 * Web Push for agents that need the user or finished (DESIGN.md §4 Push, DESIGN-v2 T11), after Shepherdr
 * `service/push.ts`:
 * - devices fetch the VAPID public key from `GET <mount>/push/key` (a `device`-level {@link Route}: `/api/*` is the
 *   server's own) and subscribe over their socket with `push.sub`; an endpoint outside the three push services of
 *   DESIGN-v2 §1.2 is acked `{ok:false, error:"refused", message:"unsupported push service"}`;
 * - {@link PushService.watch} turns core events into alerts ({@link AlertTracker}); nothing is sent while any device
 *   socket reports `visible:true`;
 * - each alert is encrypted per subscription (RFC 8291) and signed (RFC 8292). A subscription the push service
 *   reports gone (404/410), of a device no longer paired, or outside the allowlist is dropped.
 */

import type { PushSub, PushSubscription, Visible } from "@herdr-relay/protocol";
import type { DeviceIdentity } from "../auth/mod.ts";
import type { CoreClientListener, CoreTerminal } from "../core/mod.ts";
import { json, type Route, type SessionConnection, text } from "../server/mod.ts";
import { AlertTracker, type PushAlert } from "./alerts.ts";
import { ensureVapidKeys, type StoredSubscription, subscriptionProblem, SubscriptionStore } from "./store.ts";
import { encryptPayload, isAllowedEndpoint, MAX_PAYLOAD_BYTES, vapidAuthorization, type VapidKeys } from "./webpush.ts";

/** Mount-relative path of the VAPID public key. */
export const PUSH_KEY_PATH = "/push/key";
/** How long a push service keeps an undelivered alert, seconds. */
export const PUSH_TTL_S = 24 * 3600;
/** Deadline of one delivery. */
export const SEND_TIMEOUT_MS = 10_000;

export interface PushServiceOptions {
  /** `<state>` (0700): `vapid.json`, `push.json`. */
  stateDir: string;
  /** The VAPID `sub` claim (RFC 8292): an `https:` URL or `mailto:`, e.g. `https://<MagicDNS name>`. */
  subject: () => string;
  /** Whether a device is still paired; other devices' subscriptions are dropped before sending. Default: all are. */
  devicePaired?: (deviceId: string) => boolean;
  /** HTTP client; tests inject one. The bridge's `--allow-net` admits only the push services. */
  fetch?: typeof fetch;
  /** Diagnostics sink. Default: `console.error` with a `herdr-relay: push:` prefix. */
  log?: (line: string) => void;
}

/** What one delivery got: the push service's HTTP status, or the error that stopped it. */
export interface PushDelivery {
  endpoint: string;
  status: number | null;
  error?: string;
}

/** The JSON the service worker receives (`packages/web/sw.js`). */
export interface PushPayload {
  title: string;
  body: string;
  /** Replaces an earlier notification of the same terminal. */
  tag: string;
  /** Mount-relative URL opened on tap. */
  url: string;
  terminal: string;
  kind: PushAlert["kind"];
}

/** The core client as the push triggers use it ({@link CoreClient} satisfies it). */
export interface AlertSource {
  readonly terminals: ReadonlyMap<string, CoreTerminal>;
  on(listener: CoreClientListener): () => void;
}

export function pushPayload(alert: PushAlert): PushPayload {
  return {
    title: alert.title,
    body: alert.body,
    tag: alert.terminal,
    url: `./?terminal=${encodeURIComponent(alert.terminal)}`,
    terminal: alert.terminal,
    kind: alert.kind,
  };
}

export class PushService {
  readonly store: SubscriptionStore;
  readonly #stateDir: string;
  readonly #subject: () => string;
  readonly #paired: (deviceId: string) => boolean;
  readonly #fetch: typeof fetch;
  readonly #log: (line: string) => void;
  readonly #tracker = new AlertTracker();
  /** Sessions whose page is on screen. */
  readonly #visible = new Set<string>();
  #vapid: Promise<VapidKeys> | null = null;

  constructor(o: PushServiceOptions) {
    this.#stateDir = o.stateDir;
    this.#subject = o.subject;
    this.#paired = o.devicePaired ?? (() => true);
    this.#fetch = o.fetch ?? fetch;
    this.#log = o.log ?? ((line) => console.error(`herdr-relay: push: ${line}`));
    this.store = new SubscriptionStore(o.stateDir, this.#log);
  }

  /** True while any device socket reports `visible:true`. */
  get muted(): boolean {
    return this.#visible.size > 0;
  }

  /** The VAPID public key (raw P-256, base64url) devices pass to `PushManager.subscribe`; made on first use. */
  async publicKey(): Promise<string> {
    return (await this.#keys()).publicKey;
  }

  /** Handles `visible` and `push.sub` (acked) from a device socket. */
  async message(conn: SessionConnection, msg: Visible | PushSub): Promise<void> {
    if (msg.t === "visible") {
      if (msg.visible) this.#visible.add(conn.id);
      else this.#visible.delete(conn.id);
      return;
    }
    const refusal = await this.subscribe(msg.subscription, conn.device);
    if (refusal) conn.send({ t: "ack", id: msg.id, ok: false, error: "refused", message: refusal });
    else conn.send({ t: "ack", id: msg.id, ok: true });
  }

  /** The socket is gone: it no longer counts as visible. */
  drop(conn: SessionConnection): void {
    this.#visible.delete(conn.id);
  }

  /** Keeps a device's subscription; resolves with the refusal text instead when it is not acceptable. */
  async subscribe(subscription: PushSubscription, device: DeviceIdentity): Promise<string | null> {
    const problem = subscriptionProblem(subscription.endpoint, subscription.keys);
    if (problem) {
      this.#log(`refused a subscription of device ${device.id}: ${problem} (${hostOf(subscription.endpoint)})`);
      return problem;
    }
    await this.store.add({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      device: device.id,
      at: Date.now(),
    });
    return null;
  }

  /** Sends `alert` to every subscription unless a device is visible (then nothing is sent). Never rejects. */
  async notify(alert: PushAlert): Promise<PushDelivery[]> {
    if (this.muted) return [];
    let vapid: VapidKeys;
    try {
      await this.store.load();
      vapid = await this.#keys();
    } catch (e) {
      this.#log(`cannot send "${alert.title}" for ${alert.terminal}: ${messageOf(e)}`);
      return [];
    }
    const payload = new TextEncoder().encode(JSON.stringify(pushPayload(alert)));
    if (payload.length > MAX_PAYLOAD_BYTES) {
      this.#log(`alert for ${alert.terminal} is ${payload.length} bytes; not sent`);
      return [];
    }
    const gone: string[] = [];
    const deliveries = await Promise.all(this.store.list.map(async (sub): Promise<PushDelivery> => {
      if (!isAllowedEndpoint(sub.endpoint) || !this.#paired(sub.device)) {
        gone.push(sub.endpoint);
        return { endpoint: sub.endpoint, status: null, error: "subscription dropped" };
      }
      try {
        const status = await this.#send(sub, payload, vapid);
        if (status === 404 || status === 410) gone.push(sub.endpoint);
        else if (status < 200 || status > 299) this.#log(`${hostOf(sub.endpoint)} answered ${status}`);
        return { endpoint: sub.endpoint, status };
      } catch (e) {
        this.#log(`sending to ${hostOf(sub.endpoint)} failed: ${messageOf(e)}`);
        return { endpoint: sub.endpoint, status: null, error: messageOf(e) };
      }
    }));
    if (gone.length) {
      await this.store.remove(gone).catch((e) => this.#log(`cannot update ${this.store.path}: ${messageOf(e)}`));
    }
    return deliveries;
  }

  /** Follows the core client's events and pushes their alerts; returns the unsubscribe function. */
  watch(core: AlertSource): () => void {
    return core.on((event) => {
      for (const alert of this.#tracker.update(event, core.terminals)) void this.notify(alert);
    });
  }

  /** `GET <mount>/push/key` → `{publicKey}` for paired devices and loopback-token clients. */
  route(): Route {
    return {
      prefix: PUSH_KEY_PATH,
      level: "device",
      handle: async (req, ctx) => {
        if (ctx.path !== PUSH_KEY_PATH) return text("not found", 404);
        if (req.method !== "GET") return text("GET only", 405);
        return json({ publicKey: await this.publicKey() });
      },
    };
  }

  async #send(sub: StoredSubscription, payload: Uint8Array, vapid: VapidKeys): Promise<number> {
    const body = await encryptPayload(payload, sub.keys);
    const res = await this.#fetch(sub.endpoint, {
      method: "POST",
      body,
      redirect: "error",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: {
        authorization: await vapidAuthorization(sub.endpoint, vapid, this.#subject()),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(PUSH_TTL_S),
        urgency: "high",
      },
    });
    await res.body?.cancel();
    return res.status;
  }

  #keys(): Promise<VapidKeys> {
    this.#vapid ??= ensureVapidKeys(this.#stateDir).catch((e) => {
      this.#vapid = null;
      throw e;
    });
    return this.#vapid;
  }
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "an unparseable endpoint";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
