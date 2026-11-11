/**
 * What a push service answers is untrusted and may echo the request back. Before any of it reaches the bridge log or a
 * `push.test` ack it is redacted, before truncation: the subscription's endpoint (whole → its host; its path, every
 * path segment and every base64url piece of one of {@link SEGMENT_MIN}+ characters → `[path]`; also percent- or
 * JSON-escaped), its `p256dh`/`auth` keys (base64url or base64, with or without padding → `[key]`), every other URL
 * (`[url]`), and every run of {@link TOKEN_MIN}+ base64url or hex characters (`[redacted]`) unless it is a plain
 * identifier such as `TooManyProviderTokenUpdates` or `INVALID_ARGUMENT` (letters only, each `_`/`-` part lowercase,
 * uppercase or CamelCase, not all hex). An `apns-id` is kept only when it is a UUID.
 */

/** What identifies one subscription (`StoredSubscription` satisfies it). */
export interface SubscriptionSecrets {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Shortest run of base64url or hex characters treated as a token. */
export const TOKEN_MIN = 16;
/** Shortest endpoint path segment removed on its own; shorter ones are `fcm`, `send`, `wpush`, `v2`. */
export const SEGMENT_MIN = 8;

/** A URL, also percent-encoded (`https%3A%2F%2F…`), up to the first space, quote or bracket. */
const URL_TEXT = /\b[a-z][a-z0-9+.-]*(?::\/\/|%3a%2f%2f)[^\s"'<>()[\]{}]+/gi;
const TOKEN_RUN = new RegExp(`[A-Za-z0-9_-]{${TOKEN_MIN},}=*`, "g");
/** One `_`/`-` part of an identifier: lowercase, uppercase, or CamelCase (every capital followed by lowercase). */
const IDENTIFIER_PART = /^(?:[a-z]+|[A-Z]+|[A-Z]?[a-z]+(?:[A-Z][a-z]+)*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `text` (a push service's reason, a delivery error) without anything that identifies or reaches a subscription. */
export function redactDiagnostic(text: string, secrets: SubscriptionSecrets): string {
  // JSON escapes of `/` would hide URLs and paths from the patterns below.
  let out = text.replace(/\\u002f/gi, "/").replace(/\\\//g, "/");
  for (const [literal, mark] of literalsOf(secrets)) out = out.replace(new RegExp(regExpOf(literal), "gi"), mark);
  out = out.replace(URL_TEXT, "[url]");
  return out.replace(TOKEN_RUN, (run) => isIdentifier(run) ? run : "[redacted]");
}

/** The `apns-id` header when it is a UUID (Apple's form), else undefined. */
export function apnsIdOf(header: string | null): string | undefined {
  const id = header?.trim() ?? "";
  return UUID.test(id) ? id : undefined;
}

/** The subscription's own strings with what replaces them, longest first. */
function literalsOf({ endpoint, keys }: SubscriptionSecrets): [string, string][] {
  const out: [string, string][] = [];
  let url: URL | null = null;
  try {
    url = new URL(endpoint);
  } catch {
    // Not a URL: removed as text only.
  }
  const host = url?.host || "[endpoint]";
  out.push([endpoint, host], [encodeURIComponent(endpoint), host]);
  if (url) {
    const path = url.pathname + url.search;
    if (path.length > 1) out.push([path, "[path]"], [encodeURIComponent(path), "[path]"]);
    for (const segment of url.pathname.split("/")) {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Not valid percent-encoding: the segment as it is.
      }
      // FCM's `<instance id>:<token>` and the like: each piece identifies the subscription on its own.
      for (const piece of [segment, decoded, ...decoded.split(/[^A-Za-z0-9_-]+/)]) {
        if (piece.length >= SEGMENT_MIN) out.push([piece, "[path]"]);
      }
    }
  }
  for (const key of [keys.p256dh, keys.auth]) {
    const bare = key.replace(/=+$/, "");
    if (bare !== "") out.push([bare, "[key]"], [bare.replaceAll("-", "+").replaceAll("_", "/"), "[key]"]);
  }
  return out.filter(([literal]) => literal !== "").sort((a, b) => b[0].length - a[0].length);
}

/** A run of letters that reads as a protocol word (`BadJwtToken`, `INVALID_ARGUMENT`), not a token. */
function isIdentifier(run: string): boolean {
  if (/[0-9=]/.test(run) || /^[a-f]+$/i.test(run)) return false;
  return run.split(/[_-]/).every((part) => IDENTIFIER_PART.test(part));
}

function regExpOf(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
