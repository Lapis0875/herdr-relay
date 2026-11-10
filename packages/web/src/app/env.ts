/**
 * Where the app runs: the mount (`/herdr-relay/`, the same on loopback and behind `tailscale serve --set-path`),
 * the loopback bearer token handed over in `?token=` (simulators, emulators; never stored beyond the tab), the
 * device label sent in `hello.device`, and the device class of the current viewport (DESIGN.md §3).
 */

import { classifyDevice, type DeviceClass, type Viewport } from "@herdr-relay/protocol";

/** The path the bridge is published under (`MOUNT` in the bridge's config). */
export const MOUNT = "/herdr-relay";

const TOKEN_KEY = "herdr-relay.token";
const DEVICE_KEY = "herdr-relay.device";

/** `<origin>/herdr-relay/`: every URL of the app resolves against it. */
export function baseUrl(): URL {
  return new URL(`${MOUNT}/`, location.origin);
}

/** A mount-relative URL (`api/ticket` → `<origin>/herdr-relay/api/ticket`). */
export function appUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ""), baseUrl()).href;
}

/** The device socket URL for a one-time ticket. */
export function socketUrl(ticket: string): string {
  const url = new URL("ws", baseUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.href;
}

/** Parameters the page was opened with, taken out of the address bar so they are not bookmarked or shared. */
export interface LaunchParams {
  /** `?terminal=<address>`: a push notification was tapped; focus that terminal once connected. */
  terminal: string | null;
}

/**
 * Reads and strips `?token=` (kept in `sessionStorage` for this tab only) and `?terminal=` from the address bar.
 * Call once at boot.
 */
export function takeLaunchParams(): LaunchParams {
  const url = new URL(location.href);
  const token = url.searchParams.get("token");
  const terminal = url.searchParams.get("terminal");
  if (token !== null) {
    if (/^[0-9a-f]{16,128}$/i.test(token)) sessionStorage.setItem(TOKEN_KEY, token);
    url.searchParams.delete("token");
  }
  if (terminal !== null) url.searchParams.delete("terminal");
  if (token !== null || terminal !== null) history.replaceState(history.state, "", url.href);
  return { terminal: terminal && terminal.length <= 200 ? terminal : null };
}

/** The loopback bearer token of this tab, or `null` (tailnet devices use their pairing cookie instead). */
export function loopbackToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

/** A stable label for this browser (`hello.device`); the bridge identifies the device by its cookie, not this. */
export function deviceLabel(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    const kind = guessDeviceName().toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const random = crypto.getRandomValues(new Uint8Array(4));
    id = `${kind}-${Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/** A human name for this device, the default for pairing. */
export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  const pixel = /Pixel [0-9][^;)]*/.exec(ua);
  if (pixel) return pixel[0].trim();
  if (/Android/.test(ua)) return "Android";
  return "Browser";
}

/** iPhone/iPad Safari, where Web Push needs the app on the Home Screen. */
export function isAppleMobile(): boolean {
  return guessDeviceName().startsWith("iP");
}

/** Running as an installed app (Home Screen / installed PWA). */
export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || matchMedia("(display-mode: standalone)").matches;
}

export function currentViewport(): Viewport {
  return { w: Math.max(1, innerWidth), h: Math.max(1, innerHeight), dpr: devicePixelRatio || 1 };
}

/** The device class of the current viewport and primary pointer (`classifyDevice`). */
export function currentClass(): DeviceClass {
  return classifyDevice(currentViewport(), matchMedia("(pointer: fine)").matches);
}
