/**
 * Who may reach the bridge (DESIGN.md §4, Shepherdr `auth.ts` semantics). Two ways in, nothing else:
 *
 * - **Tailnet**, through `tailscale serve`: `Tailscale-User-Login` must be the machine owner's, `Host` the machine's
 *   MagicDNS name, and the connection must come from tailscaled (peer check, run last because it spawns). Writes and
 *   sockets also need `Origin: https://<dns>`; writes also the `X-Herdr-Relay: 1` header no form or link can send.
 *   Refused outright in `insecure-no-sandbox` mode.
 * - **Loopback**: `Host` is `127.0.0.1:<port>` / `localhost:<port>` (dev: also the Android emulator's `10.0.2.2`).
 *   Where the token is required it must be `Authorization: Bearer <token>` and is never accepted with an `Origin`
 *   header (no browser page uses it). Token-free loopback requests (the app shell, a ticketed WebSocket) may carry
 *   only a same-origin loopback `Origin`.
 *
 * Any request: `OPTIONS` (CORS preflight) is refused, and so is `Sec-Fetch-Site: cross-site` — with one exception: a
 * top-level navigation to the app shell's page (the caller passes `navigate` access only for the shell's HTML routes,
 * never `/api/*`, `/ws`, assets or other extension routes), proven by its fetch metadata: GET/HEAD,
 * `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` (or no `Sec-Fetch-Dest`) and no `Origin`. That is how Android
 * opens the app from an intent, a link in another app or a notification. Such a request still passes every transport
 * check below, and the page it gets is the static shell: no cookie, ticket or session is issued for it. A loopback
 * `?token=` in that URL is not read by the bridge at all; the shell's own script moves it to `sessionStorage` and
 * presents it only as `Authorization: Bearer` on its same-origin `fetch`es (no `Origin`), which this gate checks as
 * usual — so a cross-site navigation can load the page but never authenticate by itself. Frames (`Sec-Fetch-Dest:
 * iframe`/`frame`, also refused by `X-Frame-Options: DENY`), subresources, `fetch`/`no-cors`/`cors` and WebSockets stay
 * refused cross-site.
 * The gate is the transport check only; the paired-device check (second factor) follows in `Auth`.
 */

import type { TailnetIdentity } from "./tailscale.ts";
import { sameSecret } from "./secret.ts";

/** The custom header tailnet writes must carry. */
export const CUSTOM_HEADER = "x-herdr-relay";

/**
 * `read`: GET/HEAD; `write`: anything else; `socket`: a WebSocket upgrade; `navigate`: a GET/HEAD of the app shell's
 * page — `read`, plus the cross-site top-level navigation exception above.
 */
export type Access = "read" | "write" | "socket" | "navigate";

/**
 * Whether fetch metadata marks a top-level navigation that loads a document: GET/HEAD, `Sec-Fetch-Mode: navigate`,
 * `Sec-Fetch-Dest: document` or absent, and no `Origin` (browsers send none on a GET navigation).
 */
export function isDocumentNavigation(method: string, headers: Headers): boolean {
  const dest = headers.get("sec-fetch-dest");
  return (method === "GET" || method === "HEAD") && headers.get("sec-fetch-mode") === "navigate" &&
    (dest === null || dest === "document") && headers.get("origin") === null;
}

export interface GateConfig {
  port: number;
  token: string;
  /** `null` while Tailscale is not running or not logged in. */
  tailnet: TailnetIdentity | null;
  /** `false` in `insecure-no-sandbox`: every tailnet request is refused. */
  tailnetEnabled: boolean;
  /** Loopback host names (without port) besides `127.0.0.1` and `localhost`. */
  extraLoopbackHosts: readonly string[];
}

export interface GateRequest {
  method: string;
  headers: Headers;
  access: Access;
  /** Loopback only: require the bearer token (and therefore no `Origin`). */
  token: boolean;
  /** Whether tailscaled (or this user) opened the connection; called only for an otherwise valid tailnet request. */
  peerTrusted: () => Promise<boolean>;
}

export type GatePass =
  | { ok: true; via: "tailnet"; login: string }
  | { ok: true; via: "local"; token: boolean }
  | { ok: false; status: number; why: string };

const deny = (status: number, why: string): GatePass => ({ ok: false, status, why });

export async function gate(r: GateRequest, g: GateConfig): Promise<GatePass> {
  const h = r.headers;
  const host = (h.get("host") ?? "").toLowerCase();
  const origin = h.get("origin");
  if (r.method === "OPTIONS") return deny(403, "no cross-site requests");
  if (r.access === "navigate" && r.method !== "GET" && r.method !== "HEAD") return deny(405, "GET only");
  if (h.get("sec-fetch-site") === "cross-site" && !(r.access === "navigate" && isDocumentNavigation(r.method, h))) {
    return deny(403, "cross-site");
  }

  const login = h.get("tailscale-user-login");
  if (login !== null) {
    if (!g.tailnetEnabled) return deny(403, "tailnet access is off (HERDR_RELAY_DEV=insecure-no-sandbox)");
    if (!g.tailnet) return deny(503, "Tailscale isn't running here");
    if (login !== g.tailnet.owner) return deny(403, "only this machine's owner");
    if (host !== g.tailnet.dns && host !== `${g.tailnet.dns}:443`) return deny(421, "wrong host");
    if (r.access === "write" || r.access === "socket") {
      if (origin !== `https://${g.tailnet.dns}`) return deny(403, "wrong origin");
      if (r.access === "write" && h.get(CUSTOM_HEADER) !== "1") return deny(403, `missing ${CUSTOM_HEADER}`);
    }
    if (!(await r.peerTrusted())) return deny(403, "not from Tailscale");
    return { ok: true, via: "tailnet", login };
  }

  const hosts = ["127.0.0.1", "localhost", ...g.extraLoopbackHosts].map((n) => `${n}:${g.port}`);
  if (!hosts.includes(host)) return deny(421, "wrong host");
  if (r.token) {
    const auth = h.get("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!g.token || !sameSecret(given, g.token)) return deny(401, "no token");
    if (origin !== null) return deny(403, "no browser pages with the loopback token");
  } else if (origin !== null && origin !== `http://${host}`) {
    return deny(403, "wrong origin");
  }
  return { ok: true, via: "local", token: r.token };
}
