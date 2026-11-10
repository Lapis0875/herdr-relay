/**
 * The VAPID `sub` claim (RFC 8292 §2.1): how a push service can reach the sender. Apple's service refuses a token
 * whose subject is not a `mailto:` address or an `https:` URL it accepts with `403 {"reason":"BadJwtToken"}` (a
 * `localhost` subject is refused), so the claim is, in order: `HERDR_RELAY_PUSH_SUBJECT` when it is valid, then
 * `https://<MagicDNS name>` while the Tailscale identity is known, else the project page.
 */

/** Overrides the subject (e.g. `mailto:me@example.com`); read once at start when the bridge's `--allow-env` has it. */
export const PUSH_SUBJECT_ENV = "HERDR_RELAY_PUSH_SUBJECT";
/** The subject while the Tailscale name is unknown and no override is set. */
export const PUSH_SUBJECT_FALLBACK = "https://github.com/Lapis0875/herdr-relay";

/** Why `subject` is not a subject push services accept, or null: a `mailto:` address or `https:` URL, public host. */
export function subjectProblem(subject: string): string | null {
  if (subject === "" || /\s/.test(subject)) return "must not be empty or contain spaces";
  let url: URL;
  try {
    url = new URL(subject);
  } catch {
    return "is not a URL";
  }
  if (url.protocol === "mailto:") {
    const at = url.pathname.lastIndexOf("@");
    if (at < 1 || url.search !== "" || !publicHost(url.pathname.slice(at + 1))) {
      return "must be mailto:<address> at a public domain";
    }
    return null;
  }
  if (url.protocol !== "https:") return "must be a mailto: address or an https: URL";
  if (url.username !== "" || url.password !== "" || !publicHost(url.hostname)) {
    return "must be an https: URL of a public host name, without credentials";
  }
  return null;
}

/** A dotted DNS name that is neither `localhost` nor an IP address. */
function publicHost(host: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) && !/(^|\.)localhost$/i.test(host) && !/^[\d.]+$/.test(host);
}

/**
 * `HERDR_RELAY_PUSH_SUBJECT` when set and valid, else null. A variable the bridge's `--allow-env` does not grant reads
 * as unset (never a prompt); an invalid value is logged and ignored.
 */
export function subjectOverride(
  log: (line: string) => void,
  get: (name: string) => string | undefined = grantedEnv,
): string | null {
  const value = get(PUSH_SUBJECT_ENV);
  if (value === undefined || value === "") return null;
  const problem = subjectProblem(value);
  if (problem) {
    log(`${PUSH_SUBJECT_ENV} ${problem}; ignored`);
    return null;
  }
  log(`VAPID subject from ${PUSH_SUBJECT_ENV}: ${value}`);
  return value;
}

/** The subject to sign with: the override, else `https://<MagicDNS name>`, else {@link PUSH_SUBJECT_FALLBACK}. */
export function vapidSubject(override: string | null, tailnetDns: string | null): string {
  if (override !== null) return override;
  return tailnetDns ? `https://${tailnetDns}` : PUSH_SUBJECT_FALLBACK;
}

function grantedEnv(name: string): string | undefined {
  const granted = Deno.permissions.querySync({ name: "env", variable: name }).state === "granted";
  return granted ? Deno.env.get(name) : undefined;
}
