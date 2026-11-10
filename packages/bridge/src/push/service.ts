/**
 * Web Push for agents that need the user or finished (DESIGN.md §4 Push, DESIGN-v2 T11), after Shepherdr
 * `service/push.ts`:
 * - devices fetch the VAPID public key from `GET <mount>/push/key` (a `device`-level {@link Route}: `/api/*` is the
 *   server's own) and subscribe over their socket with `push.sub`; an endpoint outside the three push services of
 *   DESIGN-v2 §1.2 is acked `{ok:false, error:"refused", message:"unsupported push service"}`;
 * - {@link PushService.watch} turns core events into alerts ({@link AlertTracker}); nothing is sent while any device
 *   socket reports `visible:true`;
 * - `push.test` sends one test notification to the asking device's own subscriptions at once, visible or not (one per
 *   {@link TEST_INTERVAL_MS} per device), and acks what each push service answered;
 * - each message is encrypted per subscription (RFC 8291) and signed (RFC 8292). A subscription the push service
 *   reports gone (404/410), of a device no longer paired, or outside the allowlist is dropped; any other answer keeps
 *   it. Every send is logged as `<service host> <status> [<apns-id or reason>]`, never with the endpoint's path.
 */

import type { PushSub, PushSubscription, PushTest, Visible } from "@herdr-relay/protocol";
import type { DeviceIdentity } from "../auth/mod.ts";
import type { CoreClientListener, CoreTerminal } from "../core/mod.ts";
import { json, type Route, type SessionConnection, text } from "../server/mod.ts";
import { AlertTracker, type PushAlert } from "./alerts.ts";
import { ensureVapidKeys, type StoredSubscription, subscriptionProblem, SubscriptionStore } from "./store.ts";
import { PUSH_SUBJECT_ENV } from "./subject.ts";
import { encryptPayload, isAllowedEndpoint, MAX_PAYLOAD_BYTES, vapidAuthorization, type VapidKeys } from "./webpush.ts";

/** Mount-relative path of the VAPID public key. */
export const PUSH_KEY_PATH = "/push/key";
/** How long a push service keeps an undelivered alert, seconds. */
export const PUSH_TTL_S = 24 * 3600;
/** Deadline of one delivery. */
export const SEND_TIMEOUT_MS = 10_000;
/** Shortest time between two accepted `push.test` of one device. */
export const TEST_INTERVAL_MS = 5_000;
/** Title of the test notification. */
export const TEST_TITLE = "herdr-relay";
/** Tag of the test notification: a newer test replaces it. */
export const TEST_TAG = "herdr-relay:test";
/** Longest push-service reason kept for the log and the `push.test` ack. */
export const REASON_MAX = 120;
/** Most bytes of a refusal's body read for its reason. */
const REASON_READ_BYTES = 2048;

export interface PushServiceOptions {
  /** `<state>` (0700): `vapid.json`, `push.json`. */
  stateDir: string;
  /** The VAPID `sub` claim (RFC 8292): an `https:` URL or `mailto:` (`vapidSubject`, `./subject.ts`). */
  subject: () => string;
  /** The Mac's name in the test notification's body (`Test notification from <name>`). Default: `the Mac`. */
  machineName?: () => string;
  /** Whether a device is still paired; other devices' subscriptions are dropped before sending. Default: all are. */
  devicePaired?: (deviceId: string) => boolean;
  /** HTTP client; tests inject one. The bridge's `--allow-net` admits only the push services. */
  fetch?: typeof fetch;
  /** Diagnostics sink. Default: `console.error` with a `herdr-relay: push:` prefix. */
  log?: (line: string) => void;
  /** Clock of the `push.test` rate limit, ms. Default: `Date.now`. */
  now?: () => number;
}

/** What one delivery got: the push service's answer, or why there was none. */
export interface PushDelivery {
  endpoint: string;
  /** The push service's HTTP status; null when nothing was sent or no answer came. */
  status: number | null;
  /** Apple's `apns-id` of a message it accepted. */
  apnsId?: string;
  /** Why the push service refused: its JSON `reason`/`message`, else its body text; one line, ≤ {@link REASON_MAX}. */
  reason?: string;
  /** Why nothing was sent (`subscription dropped`) or no answer came (`push service unreachable: …`). */
  error?: string;
}

/** The outcome of `push.test`, as its ack carries it. */
export interface PushTestResult {
  /** At least one push service accepted the message. */
  ok: boolean;
  message: string;
}

/** The JSON the service worker receives (`packages/web/sw.js`). */
export interface PushPayload {
  title: string;
  body: string;
  /** Replaces an earlier notification of the same terminal (or the earlier test). */
  tag: string;
  /** Mount-relative URL opened on tap. */
  url: string;
  /** The terminal an alert is about; absent on the test notification. */
  terminal?: string;
  kind?: PushAlert["kind"];
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
  readonly #machineName: () => string;
  readonly #paired: (deviceId: string) => boolean;
  readonly #fetch: typeof fetch;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #tracker = new AlertTracker();
  /** Sessions whose page is on screen. */
  readonly #visible = new Set<string>();
  /** `now()` of each device's last accepted `push.test`, kept for {@link TEST_INTERVAL_MS}. */
  readonly #tested = new Map<string, number>();
  /** "No subscriptions" was logged since the last subscription arrived (it is logged once). */
  #noSubscriptionsLogged = false;
  #vapid: Promise<VapidKeys> | null = null;

  constructor(o: PushServiceOptions) {
    this.#stateDir = o.stateDir;
    this.#subject = o.subject;
    this.#machineName = o.machineName ?? (() => "the Mac");
    this.#paired = o.devicePaired ?? (() => true);
    this.#fetch = o.fetch ?? fetch;
    this.#log = o.log ?? ((line) => console.error(`herdr-relay: push: ${line}`));
    this.#now = o.now ?? Date.now;
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

  /** Handles `visible`, and `push.sub` and `push.test` (both acked), from a device socket. */
  async message(conn: SessionConnection, msg: Visible | PushSub | PushTest): Promise<void> {
    switch (msg.t) {
      case "visible":
        if (msg.visible) this.#visible.add(conn.id);
        else this.#visible.delete(conn.id);
        return;
      case "push.sub": {
        const refusal = await this.subscribe(msg.subscription, conn.device);
        if (refusal) conn.send({ t: "ack", id: msg.id, ok: false, error: "refused", message: refusal });
        else conn.send({ t: "ack", id: msg.id, ok: true });
        return;
      }
      case "push.test": {
        const { ok, message } = await this.test(conn.device);
        conn.send(ok ? { t: "ack", id: msg.id, ok, message } : { t: "ack", id: msg.id, ok, error: "refused", message });
        return;
      }
    }
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
    this.#noSubscriptionsLogged = false;
    this.#log(`device ${device.id} subscribed (${hostOf(subscription.endpoint)})`);
    return null;
  }

  /** Sends `alert` to every subscription unless a device is visible (then nothing is sent). Never rejects. */
  async notify(alert: PushAlert): Promise<PushDelivery[]> {
    const what = `"${alert.title}" for ${alert.terminal}`;
    if (this.muted) {
      this.#log(`${what} not sent: a device is on screen`);
      return [];
    }
    let vapid: VapidKeys;
    try {
      await this.store.load();
      vapid = await this.#keys();
    } catch (e) {
      this.#log(`cannot send ${what}: ${messageOf(e)}`);
      return [];
    }
    if (this.store.list.length === 0) {
      if (!this.#noSubscriptionsLogged) this.#log(`${what} not sent: no device has turned notifications on`);
      this.#noSubscriptionsLogged = true;
      return [];
    }
    const payload = new TextEncoder().encode(JSON.stringify(pushPayload(alert)));
    if (payload.length > MAX_PAYLOAD_BYTES) {
      this.#log(`${what} is ${payload.length} bytes; not sent`);
      return [];
    }
    return await this.#deliver(this.store.list, payload, vapid);
  }

  /**
   * `push.test`: one test notification to `device`'s own subscriptions, sent even while a device is visible; refused
   * within {@link TEST_INTERVAL_MS} of the device's last accepted one. Never rejects.
   */
  async test(device: DeviceIdentity): Promise<PushTestResult> {
    const now = this.#now();
    for (const [id, at] of this.#tested) if (now - at >= TEST_INTERVAL_MS) this.#tested.delete(id);
    const last = this.#tested.get(device.id);
    if (last !== undefined) {
      const wait = Math.ceil((last + TEST_INTERVAL_MS - now) / 1000);
      return { ok: false, message: `wait ${wait} s before another test notification` };
    }
    this.#tested.set(device.id, now);
    let vapid: VapidKeys;
    try {
      await this.store.load();
      vapid = await this.#keys();
    } catch (e) {
      this.#log(`cannot send a test notification to device ${device.id}: ${messageOf(e)}`);
      return { ok: false, message: "the Mac cannot read its push keys or subscriptions (see the bridge log)" };
    }
    const own = this.store.list.filter((s) => s.device === device.id);
    if (own.length === 0) {
      this.#log(`test notification for device ${device.id} not sent: it has no subscription`);
      return { ok: false, message: "no subscription for this device" };
    }
    const payload: PushPayload = {
      title: TEST_TITLE,
      body: `Test notification from ${this.#machineName()}`,
      tag: TEST_TAG,
      url: "./",
    };
    return testResult(await this.#deliver(own, new TextEncoder().encode(JSON.stringify(payload)), vapid));
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

  /**
   * Sends `payload` to each subscription and logs every answer; drops the subscriptions that are gone (404/410), of a
   * device no longer paired, or outside the allowlist. Never rejects.
   */
  async #deliver(subs: readonly StoredSubscription[], payload: Uint8Array, vapid: VapidKeys): Promise<PushDelivery[]> {
    const subject = this.#subject();
    const gone: string[] = [];
    const deliveries = await Promise.all(subs.map(async (sub): Promise<PushDelivery> => {
      const host = hostOf(sub.endpoint);
      if (!isAllowedEndpoint(sub.endpoint) || !this.#paired(sub.device)) {
        gone.push(sub.endpoint);
        this.#log(`${host} not sent: dropped the subscription of device ${sub.device} (not paired or not allowed)`);
        return { endpoint: sub.endpoint, status: null, error: "subscription dropped" };
      }
      let delivery: PushDelivery;
      try {
        delivery = await this.#send(sub, payload, vapid, subject);
      } catch (e) {
        const error = withoutPath(messageOf(e), sub.endpoint);
        this.#log(`${host} failed: ${error}`);
        return { endpoint: sub.endpoint, status: null, error: `push service unreachable: ${error}` };
      }
      if (delivery.status === 404 || delivery.status === 410) gone.push(sub.endpoint);
      this.#log(sendLine(host, delivery, subject));
      return delivery;
    }));
    if (gone.length) {
      await this.store.remove(gone).catch((e) => this.#log(`cannot update ${this.store.path}: ${messageOf(e)}`));
    }
    return deliveries;
  }

  async #send(sub: StoredSubscription, payload: Uint8Array, vapid: VapidKeys, subject: string): Promise<PushDelivery> {
    const body = await encryptPayload(payload, sub.keys);
    const res = await this.#fetch(sub.endpoint, {
      method: "POST",
      body,
      redirect: "error",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: {
        authorization: await vapidAuthorization(sub.endpoint, vapid, subject),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(PUSH_TTL_S),
        urgency: "high",
      },
    });
    const delivery: PushDelivery = { endpoint: sub.endpoint, status: res.status };
    const apnsId = oneLine(res.headers.get("apns-id") ?? "", 64);
    if (apnsId) delivery.apnsId = apnsId;
    if (res.ok) {
      await res.body?.cancel();
    } else {
      const reason = await reasonOf(res);
      if (reason) delivery.reason = reason;
    }
    return delivery;
  }

  #keys(): Promise<VapidKeys> {
    this.#vapid ??= ensureVapidKeys(this.#stateDir).catch((e) => {
      this.#vapid = null;
      throw e;
    });
    return this.#vapid;
  }
}

/** The log line of one answer: `<host> <status> [<apns-id or reason>]`, and what a refusal means. */
function sendLine(host: string, d: PushDelivery, subject: string): string {
  const line = [host, String(d.status), d.reason ?? d.apnsId].filter(Boolean).join(" ");
  if (d.status === 404 || d.status === 410) return `${line} — subscription removed`;
  if (d.status === 403 && d.reason === "BadJwtToken") {
    return `${line} — Apple refused the VAPID token: check the subject ${subject} (${PUSH_SUBJECT_ENV} overrides it) ` +
      "and the Mac's clock";
  }
  if (d.status === 403) return `${line} — the VAPID token or key was refused`;
  return line;
}

/** The `push.test` ack: ok when a push service accepted it; every subscription's result, `; `-joined. */
function testResult(deliveries: readonly PushDelivery[]): PushTestResult {
  const accepted = deliveries.filter((d) => d.status !== null && d.status >= 200 && d.status <= 299);
  const parts: string[] = [];
  if (accepted.length > 0) {
    const n = deliveries.length;
    const share = accepted.length === n ? "" : `${accepted.length} of `;
    parts.push(`sent to ${share}${n} subscription${n === 1 ? "" : "s"} (${accepted.map((d) => d.status).join(", ")})`);
  }
  for (const d of deliveries) {
    if (accepted.includes(d)) continue;
    if (d.status === null) {
      parts.push(d.error ?? "not sent");
      continue;
    }
    const removed = d.status === 404 || d.status === 410 ? " (subscription removed)" : "";
    parts.push(`push service answered ${d.status}${d.reason ? `: ${d.reason}` : ""}${removed}`);
  }
  return { ok: accepted.length > 0, message: parts.join("; ") };
}

/** A refusal's reason: Apple's `{"reason"}`, Mozilla's `{"message"}`, FCM's `{"error"}`, else the body text. */
async function reasonOf(res: Response): Promise<string | undefined> {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let read = 0;
  try {
    while (read < REASON_READ_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      read += value.length;
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    // What arrived before the body broke off still says why.
  } finally {
    await reader.cancel().catch(() => {});
  }
  let reason = body;
  try {
    const data: unknown = JSON.parse(body);
    if (isObject(data)) {
      const error = data.error;
      const named = [data.reason, data.message, isObject(error) ? error.message : error]
        .find((r): r is string => typeof r === "string" && r.trim() !== "");
      if (named !== undefined) reason = named;
    }
  } catch {
    // Not JSON: the text itself, without markup.
  }
  return oneLine(reason.replace(/<[^>]*>/g, " "), REASON_MAX) || undefined;
}

/** `text` as one line of at most `max` characters. */
function oneLine(text: string, max: number): string {
  // deno-lint-ignore no-control-regex
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `message` without URL paths: a fetch error quotes the endpoint, whose path identifies the subscription. */
function withoutPath(message: string, endpoint: string): string {
  return message.replaceAll(endpoint, hostOf(endpoint)).replace(/(https?:\/\/[^/\s)'"]+)\/[^\s)'"]*/g, "$1/…");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
