/**
 * The device cookie (DESIGN.md §4): httpOnly, Secure, SameSite=Strict, scoped to the mount path so it coexists with
 * other services on the same MagicDNS host (Shepherdr serves `/shepherdr` there). `__Secure-` makes browsers refuse
 * it over plain HTTP; loopback clients use the token instead.
 */

export const DEVICE_COOKIE = "__Secure-herdr-relay-device";

/** A year; revocation is `herdr-relay revoke`, not expiry. */
const MAX_AGE_S = 365 * 24 * 3600;

/** The value of cookie `name` in a `Cookie` header, or `null`. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** `Set-Cookie` for a newly paired device. */
export function deviceCookie(secret: string, path: string): string {
  return `${DEVICE_COOKIE}=${secret}; Path=${path}; Max-Age=${MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`;
}
