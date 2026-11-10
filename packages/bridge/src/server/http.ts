/** HTTP helpers for the bridge server: mount-relative paths, JSON/text responses, hardening headers, small bodies. */

import { MOUNT } from "../config.ts";

/** Sent with every non-upgrade response. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
});

/**
 * The path below the mount. Loopback clients use `/herdr-relay/…`; `tailscale serve --set-path` may forward the
 * request with the mount stripped, so a path without it is taken as already relative. `null` for the bare mount
 * (redirected to `<mount>/` so relative URLs in the app shell resolve).
 */
export function routePath(pathname: string, mount: string = MOUNT): string | null {
  if (pathname === mount) return null;
  return pathname.startsWith(`${mount}/`) ? pathname.slice(mount.length) : pathname;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Adds {@link SECURITY_HEADERS}; a response with immutable headers is copied. WebSocket upgrades pass through. */
export function secured(res: Response): Response {
  if (res.status === 101) return res;
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

export class BodyError extends Error {}

/** A JSON object body of at most `max` bytes. */
export async function readJsonObject(req: Request, max = 16 * 1024): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) throw new BodyError(`body over ${max} bytes`);
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > max) throw new BodyError(`body over ${max} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BodyError("body is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BodyError("body is not an object");
  return value as Record<string, unknown>;
}
