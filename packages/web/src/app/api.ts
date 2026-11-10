/**
 * The bridge's HTTP endpoints the app uses (`packages/bridge/src/server/server.ts`):
 * `GET api/hello` (who am I, paired?), `GET api/ticket` (one-time WebSocket ticket; needs `X-Herdr-Relay: 1`),
 * `POST api/pair` (redeem a 6-digit code; tailnet only; sets the device cookie) and `GET push/key` (the VAPID
 * application server key, T11). Loopback tabs add the bearer token from `?token=`; same-origin GETs carry no
 * `Origin`, which the loopback gate requires.
 */

import type { Scope } from "@herdr-relay/protocol";
import { appUrl, loopbackToken } from "./env.ts";

/** The custom header every app request carries (`CUSTOM_HEADER`; required for tickets and tailnet writes). */
export const CUSTOM_HEADER = "X-Herdr-Relay";

export interface DeviceView {
  id: string;
  name: string;
  scope: Scope;
}

/** `GET api/hello`. */
export interface HelloInfo {
  v: number;
  via: "local" | "tailnet";
  login: string | null;
  paired: boolean;
  device: DeviceView | null;
  /** Pairing codes can be redeemed (off in `insecure-no-sandbox`). */
  pairing: boolean;
  url: string | null;
}

/** A non-2xx answer; `message` is the bridge's one-line reason. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

async function call(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(CUSTOM_HEADER, "1");
  const token = loopbackToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(appUrl(path), {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const why = (await res.text().catch(() => "")).trim().split("\n")[0] || res.statusText || "request failed";
    throw new HttpError(res.status, why);
  }
  return res;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isDevice(v: unknown): v is DeviceView {
  return isObject(v) && typeof v.id === "string" && typeof v.name === "string" &&
    (v.scope === "read" || v.scope === "act");
}

export async function fetchHello(): Promise<HelloInfo> {
  const body: unknown = await (await call("api/hello")).json();
  if (!isObject(body) || (body.via !== "local" && body.via !== "tailnet")) {
    throw new HttpError(502, "unexpected answer from api/hello");
  }
  return {
    v: typeof body.v === "number" ? body.v : 0,
    via: body.via,
    login: typeof body.login === "string" ? body.login : null,
    paired: body.paired === true,
    device: isDevice(body.device) ? body.device : null,
    pairing: body.pairing === true,
    url: typeof body.url === "string" ? body.url : null,
  };
}

/** A one-time WebSocket ticket (valid 30 s). */
export async function fetchTicket(): Promise<string> {
  const body: unknown = await (await call("api/ticket")).json();
  if (!isObject(body) || typeof body.ticket !== "string" || body.ticket === "") {
    throw new HttpError(502, "unexpected answer from api/ticket");
  }
  return body.ticket;
}

/** Redeems a pairing code; the bridge answers with the device and sets the httpOnly device cookie. */
export async function pairDevice(code: string, name: string): Promise<DeviceView> {
  const res = await call("api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  const body: unknown = await res.json();
  if (!isObject(body) || !isDevice(body.device)) throw new HttpError(502, "unexpected answer from api/pair");
  return body.device;
}

/** The VAPID application server key (base64url, uncompressed P-256). */
export async function fetchPushKey(): Promise<string> {
  const body: unknown = await (await call("push/key")).json();
  if (!isObject(body) || typeof body.publicKey !== "string" || !/^[A-Za-z0-9_-]{80,100}$/.test(body.publicKey)) {
    throw new HttpError(502, "unexpected answer from push/key");
  }
  return body.publicKey;
}
