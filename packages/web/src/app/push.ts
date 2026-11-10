/**
 * Web Push subscription (D11, DESIGN.md §4 "Push"): the service worker (`sw.js`) holds the subscription, the
 * bridge's VAPID key comes from `GET push/key` (T11) and the subscription goes to the bridge as `push.sub` over the
 * socket — again after every `hello`, so a bridge restart or a rotated subscription is picked up. iPhone and iPad
 * deliver Web Push only to an app added to the Home Screen.
 */

import type { PushSubscription as WirePushSubscription } from "@herdr-relay/protocol";
import { fetchPushKey } from "./api.ts";
import { bridge } from "./client.ts";
import { isAppleMobile, isStandalone } from "./env.ts";

export type PushStatus =
  | { kind: "unsupported"; why: string }
  | { kind: "needs-install" }
  | { kind: "denied" }
  | { kind: "off" }
  | { kind: "on" }
  | { kind: "error"; why: string };

function base64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  const av = new Uint8Array(a);
  return av.every((x, i) => x === b[i]);
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

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return await navigator.serviceWorker.getRegistration() ?? null;
}

/** What the notifications switch can offer now (no prompt). */
export async function pushStatus(): Promise<PushStatus> {
  if (!isSecureContext) {
    return { kind: "unsupported", why: "Notifications need HTTPS: open the app through Tailscale." };
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in globalThis) || !("Notification" in globalThis)) {
    return isAppleMobile() && !isStandalone()
      ? { kind: "needs-install" }
      : { kind: "unsupported", why: "This browser has no Web Push." };
  }
  if (Notification.permission === "denied") return { kind: "denied" };
  const reg = await registration();
  if (!reg) return { kind: "unsupported", why: "The app's service worker is not installed yet; reload once." };
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? { kind: "on" } : { kind: "off" };
}

/** Asks for permission, subscribes with the bridge's key and registers the subscription. Call from a tap. */
export async function enablePush(): Promise<PushStatus> {
  try {
    const permission = await Notification.requestPermission();
    if (permission === "denied") return { kind: "denied" };
    if (permission !== "granted") return { kind: "off" };
    const reg = await navigator.serviceWorker.ready;
    const key = base64urlBytes(await fetchPushKey());
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const w = wire(sub);
    if (!w) return { kind: "error", why: "The browser returned an incomplete subscription." };
    const ack = await bridge.pushSubscription(w);
    if (!ack.ok) {
      if (ack.message !== "offline") await sub.unsubscribe();
      return {
        kind: "error",
        why: ack.message === "offline" ? "Not connected to the Mac; try again." : ack.message ?? "The Mac refused it.",
      };
    }
    return { kind: "on" };
  } catch (e) {
    return { kind: "error", why: e instanceof Error ? e.message : String(e) };
  }
}

/** Stops notifications on this device (the bridge drops the endpoint once the push service reports it gone). */
export async function disablePush(): Promise<PushStatus> {
  try {
    const sub = await (await registration())?.pushManager.getSubscription();
    await sub?.unsubscribe();
    return { kind: "off" };
  } catch (e) {
    return { kind: "error", why: e instanceof Error ? e.message : String(e) };
  }
}

/** Re-sends an existing subscription after a (re)connect. */
export async function resendSubscription(): Promise<void> {
  if (!isSecureContext || !("Notification" in globalThis) || Notification.permission !== "granted") return;
  const sub = await (await registration())?.pushManager.getSubscription().catch(() => null);
  const w = sub ? wire(sub) : null;
  if (w) await bridge.pushSubscription(w);
}
