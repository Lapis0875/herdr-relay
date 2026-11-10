/**
 * Web Push subscription (D11, DESIGN.md §4 "Push"): the service worker (`sw.js`, scope `/herdr-relay/`) holds the
 * subscription, the bridge's VAPID key comes from `GET push/key` (T11) and the subscription goes to the bridge as
 * `push.sub` over the socket — again after every `hello`, so a bridge restart or a rotated subscription is picked up.
 * `push.test` asks the bridge for one notification to this device's subscriptions. iPhone and iPad deliver Web Push
 * only to an app added to the Home Screen, and show the permission prompt only while handling a tap.
 */

import type { PushSubscription as WirePushSubscription } from "@herdr-relay/protocol";
import { fetchPushKey } from "./api.ts";
import { bridge } from "./client.ts";
import { baseUrl, isAppleMobile, isStandalone } from "./env.ts";

export type PushStatus =
  | { kind: "unsupported"; why: string }
  | { kind: "needs-install" }
  | { kind: "denied" }
  | { kind: "off"; why?: string }
  | { kind: "on" }
  | { kind: "error"; why: string };

/** The service worker and subscription behind {@link PushStatus}, shown for debugging. */
export interface PushDetails {
  /** The app's registration: its newest usable worker, `none` without one, `unavailable` without service workers. */
  worker: "unavailable" | "none" | "installing" | "waiting" | "active";
  /** The registration's scope path (`/herdr-relay/`). */
  scope: string | null;
  /** Whether a service worker controls this page. */
  controlled: boolean;
  /** `Notification.permission`, `null` where notifications do not exist. */
  permission: NotificationPermission | null;
  /** The push service host of this browser's subscription (`web.push.apple.com`), `null` without one. */
  service: string | null;
}

/** What `push.test` did, for the person: the bridge's answer verbatim. */
export interface PushTestResult {
  ok: boolean;
  text: string;
}

/** How long enabling waits for a first install of the service worker to activate. */
const ACTIVATE_TIMEOUT_MS = 10_000;

function base64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  const av = new Uint8Array(a);
  return av.every((x, i) => x === b[i]);
}

function describe(e: unknown): string {
  if (e instanceof DOMException) return `${e.name}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

function wire(sub: PushSubscription): WirePushSubscription | null {
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return null;
  return {
    endpoint: j.endpoint,
    expirationTime: j.expirationTime ?? null,
    keys: { p256dh: j.keys.p256dh, auth: j.keys.auth },
  };
}

/** The app's registration, looked up by its scope (not by this page's URL). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return await navigator.serviceWorker.getRegistration(baseUrl().href) ?? null;
}

/** The app's registration once a worker is active (a first install may still be running), or `null`. */
async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  const reg = await registration();
  if (!reg || reg.active) return reg;
  const worker = reg.installing ?? reg.waiting;
  if (!worker) return null;
  const { promise, resolve } = Promise.withResolvers<ServiceWorkerRegistration | null>();
  const check = () => {
    if (reg.active) resolve(reg);
    else if (worker.state === "redundant") resolve(null);
  };
  worker.addEventListener("statechange", check);
  const timer = setTimeout(() => resolve(reg.active ? reg : null), ACTIVATE_TIMEOUT_MS);
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    worker.removeEventListener("statechange", check);
  }
}

/** What the notifications switch can offer now (no prompt). */
export async function pushStatus(): Promise<PushStatus> {
  if (!isSecureContext) {
    return { kind: "unsupported", why: "Notifications need HTTPS: open the app through its Tailscale address." };
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in globalThis) || !("Notification" in globalThis)) {
    if (isAppleMobile()) {
      return isStandalone()
        ? { kind: "unsupported", why: "Notifications need iOS or iPadOS 16.4 or later." }
        : { kind: "needs-install" };
    }
    return { kind: "unsupported", why: "This browser has no Web Push." };
  }
  if (Notification.permission === "denied") return { kind: "denied" };
  try {
    const reg = await registration();
    if (!reg) {
      return { kind: "unsupported", why: "The app’s service worker is not registered yet. Reload the app once." };
    }
    const sub = await reg.pushManager.getSubscription();
    return sub && Notification.permission === "granted" ? { kind: "on" } : { kind: "off" };
  } catch (e) {
    return { kind: "error", why: `Reading the subscription failed: ${describe(e)}` };
  }
}

/** The service worker and subscription as this browser reports them (no prompt). */
export async function pushDetails(): Promise<PushDetails> {
  const permission = "Notification" in globalThis ? Notification.permission : null;
  const none: PushDetails = { worker: "unavailable", scope: null, controlled: false, permission, service: null };
  if (!isSecureContext || !("serviceWorker" in navigator)) return none;
  const controlled = navigator.serviceWorker.controller !== null;
  const reg = await registration().catch(() => null);
  if (!reg) return { ...none, worker: "none", controlled };
  const sub = "PushManager" in globalThis ? await reg.pushManager.getSubscription().catch(() => null) : null;
  return {
    worker: reg.active ? "active" : reg.waiting ? "waiting" : reg.installing ? "installing" : "none",
    scope: new URL(reg.scope).pathname,
    controlled,
    permission,
    service: sub ? new URL(sub.endpoint).host : null,
  };
}

/**
 * Asks for permission, subscribes with the bridge's key and registers the subscription. Call it from the tap itself:
 * `Notification.requestPermission()` comes before the first await, as iOS and iPadOS prompt only during the tap.
 */
export async function enablePush(): Promise<PushStatus> {
  let stage = "Asking for permission";
  try {
    const permission = await Notification.requestPermission();
    if (permission === "denied") return { kind: "denied" };
    if (permission !== "granted") {
      return { kind: "off", why: "The permission prompt closed without an answer. Turn the switch on to ask again." };
    }
    stage = "Starting the service worker";
    const reg = await activeRegistration();
    if (!reg) {
      return { kind: "error", why: "The app’s service worker is not active. Reload the app and try again." };
    }
    stage = "Getting the Mac’s push key";
    const key = base64urlBytes(await fetchPushKey());
    stage = "Subscribing with the push service";
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const w = wire(sub);
    if (!w) return { kind: "error", why: "The browser returned an incomplete subscription." };
    stage = "Registering with the Mac";
    const ack = await bridge.pushSubscription(w);
    if (ack.ok) return { kind: "on" };
    // Not delivered (offline, unanswered): keep the subscription, it is sent again after the next `hello`.
    if (ack.message === "offline") return { kind: "error", why: "Not connected to the Mac; try again." };
    if (ack.message === "timed out") return { kind: "error", why: "No answer from the Mac; try again." };
    await sub.unsubscribe();
    return { kind: "error", why: `The Mac refused the subscription: ${ack.message ?? ack.error ?? "no reason given"}` };
  } catch (e) {
    return { kind: "error", why: `${stage} failed: ${describe(e)}` };
  }
}

/** Stops notifications on this device (the bridge drops the endpoint once the push service reports it gone). */
export async function disablePush(): Promise<PushStatus> {
  try {
    const sub = await (await registration())?.pushManager.getSubscription();
    await sub?.unsubscribe();
    return { kind: "off" };
  } catch (e) {
    return { kind: "error", why: `Turning notifications off failed: ${describe(e)}` };
  }
}

/** Re-sends an existing subscription after a (re)connect. */
export async function resendSubscription(): Promise<void> {
  if (!isSecureContext || !("PushManager" in globalThis) || !("Notification" in globalThis)) return;
  if (Notification.permission !== "granted") return;
  const sub = await (await registration().catch(() => null))?.pushManager.getSubscription().catch(() => null);
  const w = sub ? wire(sub) : null;
  if (w) await bridge.pushSubscription(w);
}

/** Asks the bridge for one test notification to this device's subscriptions, also while the app is in view. */
export async function sendTestPush(): Promise<PushTestResult> {
  const ack = await bridge.pushTest();
  if (!ack.ok && ack.message === "offline") return { ok: false, text: "Not connected to the Mac; try again." };
  if (!ack.ok && ack.message === "timed out") return { ok: false, text: "No answer from the Mac; try again." };
  return { ok: ack.ok, text: ack.message ?? (ack.ok ? "Sent." : `Refused (${ack.error ?? "no reason given"}).`) };
}
