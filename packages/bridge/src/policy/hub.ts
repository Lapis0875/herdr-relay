/**
 * The cockpit hub gate (`net.writes: "cockpit-hub"`, SECURITY S16 and S37, D3, U3): what a mod writes on a hub
 * connection is read as the hub's newline-delimited JSON requests and decided by the table in `./hub.table.ts`,
 * for the device the write was made for. One {@link HubStream} per connection (`../herdr/net.ts`):
 *
 * - A write is sent only when every complete request in it is admitted, and then only those request lines; a trailing
 *   partial line is held by the bridge (never sent) until the write that completes it, and decided then.
 * - A write with a refused request — an unknown op, a line that is not a JSON object with an `op`, a line over
 *   {@link HUB_LINE_MAX_BYTES}, or a request the table refuses for this caller — sends nothing and ends the stream: the
 *   connection closes, so what the mod and the hub have seen of it never diverge. Decisions stop at the first refused
 *   request.
 * - `open_url` with one http(s) URL is answered by the bridge: the URL goes to the device that asked as a link (U3,
 *   like E11) and the connection reads {@link hubOpenedReply}. Requests carry no id, so an answer of its own can only
 *   be put in order before anything the hub answers: `open_url` after a request already sent on the connection is
 *   refused (`hub.js` sends one request per connection, `hub.js:120-138`).
 */

import type { Scope, Toast } from "@herdr-relay/protocol";
import { OPEN_URL } from "./exec.table.ts";
import {
  HUB_ACT_ONLY,
  HUB_ACT_OP,
  HUB_FETCH_OP,
  HUB_FETCH_READS,
  HUB_HERDR_WINDOW_ACTS,
  HUB_HERDR_WINDOW_OPS,
  HUB_LINE_MAX_BYTES,
  HUB_OPEN_URL_ACTION,
  HUB_READ_OPS,
} from "./hub.table.ts";

/** Who a write is for, and the switch it needs. */
export interface HubCaller {
  /** The scope of the connected device session the write came from; null: no origin, or one that names no open session. */
  device: Scope | null;
  /** U3: `open_url` opens on the device that asked (`USER_DECISIONS.openUrlOnDevice`); off: refused. */
  openUrlOnDevice: boolean;
}

/** A refused request: what the policy log names (op and app/action/kind only, never the hub token) and why. */
export interface HubRefusal {
  argv: string[];
  /** Safe to show on a device; also what the mod's `net.write` rejects with. */
  reason: string;
  /** For the device that asked, when it is connected. */
  toast?: Toast;
}

/** An `open_url` the bridge answers itself. */
export interface HubOpen {
  argv: string[];
  /** The http(s) URL, normalized (`URL.href`). */
  url: string;
}

/** One write: the request lines to send (possibly none) and the links to open on the device, or why it is refused. */
export type HubWrite =
  | { kind: "send"; text: string; opens: HubOpen[] }
  | { kind: "refuse"; refusal: HubRefusal };

/** One request: sent to the hub, answered by the bridge (`open_url`), or refused. */
export type HubDecision =
  | { kind: "allow" }
  | { kind: "open"; url: string; argv: string[] }
  | { kind: "refuse"; refusal: HubRefusal };

const ALLOW: HubDecision = { kind: "allow" };

/** The toast that opens `url` on the device that asked (E11 and `open_url`, U3); `url` is http(s). */
export function openLinkToast(url: string): Toast {
  return { t: "toast", title: "Open link", body: url, level: "info", action: { open: url } };
}

/**
 * The refusal of a write that needs a connected `act` device (D3): `what` names it. A connected `read` device is told
 * so; without a device there is no one to tell.
 */
export function needsActRefusal(what: string, argv: string[], device: Scope | null): HubRefusal {
  const refusal: HubRefusal = { argv, reason: `${what} needs a connected device with act scope` };
  if (device === "read") {
    refusal.toast = { t: "toast", title: "Read-only device", body: `${what} needs act scope`, level: "warning" };
  }
  return refusal;
}

/** The refusal of a change only the Herdr window makes: refused for every caller, the device is told. */
function herdrWindowRefusal(what: string, argv: string[]): HubRefusal {
  const reason = `${what} needs the Herdr window`;
  return { argv, reason, toast: { t: "toast", title: reason, level: "warning" } };
}

const refused = (refusal: HubRefusal): HubDecision => ({ kind: "refuse", refusal });

/** UTF-8 length of `s` (a lone surrogate counts as U+FFFD, as `TextEncoder` writes it). */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const OVERSIZED: HubRefusal = { argv: [], reason: `a hub request is over ${HUB_LINE_MAX_BYTES} bytes` };

/**
 * Decides one complete request line for `caller`. `sentBefore`: a request was already sent on this connection (an
 * `open_url` answer could not be put in order).
 */
export function decideHubRequest(line: string, caller: HubCaller, sentBefore: boolean): HubDecision {
  if (utf8Length(line) > HUB_LINE_MAX_BYTES) return refused(OVERSIZED);
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    value = undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refused({ argv: [], reason: "a hub request is not a JSON object" });
  }
  const msg = value as Record<string, unknown>;
  const op = msg.op;
  if (typeof op !== "string" || op === "") return refused({ argv: [], reason: "a hub request names no op" });
  if (HUB_READ_OPS.has(op)) return ALLOW;
  if (op === HUB_FETCH_OP) {
    const kind = typeof msg.kind === "string" ? msg.kind : "";
    if (HUB_FETCH_READS.has(kind)) return ALLOW;
    return caller.device === "act" ? ALLOW : refused(needsActRefusal(`fetch ${kind}`, [op, kind], caller.device));
  }
  if (Object.hasOwn(HUB_HERDR_WINDOW_OPS, op)) return refused(herdrWindowRefusal(HUB_HERDR_WINDOW_OPS[op], [op]));
  if (op !== HUB_ACT_OP) return refused({ argv: [op], reason: `unknown hub request ${op}` });
  const { app, action } = msg;
  if (typeof app !== "string" || typeof action !== "string") {
    return refused({ argv: [op], reason: "an act request names an app and an action" });
  }
  const argv = [op, app, action];
  const windowActs = Object.hasOwn(HUB_HERDR_WINDOW_ACTS, app) ? HUB_HERDR_WINDOW_ACTS[app] : undefined;
  if (windowActs !== undefined && Object.hasOwn(windowActs, action)) {
    return refused(herdrWindowRefusal(windowActs[action], argv));
  }
  if (action === HUB_OPEN_URL_ACTION) return decideOpenUrl(msg.args, argv, caller, sentBefore);
  const only = Object.hasOwn(HUB_ACT_ONLY, app) ? HUB_ACT_ONLY[app] : undefined;
  if (only !== undefined && !only.actions.has(action)) return refused(herdrWindowRefusal(only.what, argv));
  return caller.device === "act" ? ALLOW : refused(needsActRefusal(`${app} ${action}`, argv, caller.device));
}

/** `act … open_url [url]`: an http(s) URL for a connected device, before anything was sent on the connection. */
function decideOpenUrl(args: unknown, argv: string[], caller: HubCaller, sentBefore: boolean): HubDecision {
  const arg = Array.isArray(args) && args.length === 1 && typeof args[0] === "string" ? args[0] : null;
  const logged = [...argv, arg ?? ""];
  if (!caller.openUrlOnDevice) return refused({ argv: logged, reason: "opening links from mods is off" });
  let url: URL | null = null;
  try {
    url = arg !== null && OPEN_URL.test(arg) ? new URL(arg) : null;
  } catch {
    url = null;
  }
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return refused({ argv: logged, reason: "open_url only opens http(s) links, on your device" });
  }
  if (caller.device === null) return refused({ argv: logged, reason: "no device to open the link on" });
  if (sentBefore) {
    return refused({ argv: logged, reason: "open_url after another request on the same hub connection" });
  }
  return { kind: "open", url: url.href, argv: logged };
}

/** One hub connection's requests as the mod writes them (module comment). */
export class HubStream {
  /** The partial line after the last `\n` written so far, and its UTF-8 length (kept, not recounted per write). */
  #pending = "";
  #pendingBytes = 0;
  /** A request line was sent on the connection. */
  #sent = false;
  /** A write was refused: the connection is closing and nothing more is decided. */
  #ended = false;

  write(text: string, caller: HubCaller): HubWrite {
    if (this.#ended) return { kind: "refuse", refusal: { argv: [], reason: "the hub connection was refused" } };
    const end = text.lastIndexOf("\n");
    if (end < 0) {
      const bytes = this.#pendingBytes + utf8Length(text);
      if (bytes > HUB_LINE_MAX_BYTES) return this.#refuse(OVERSIZED);
      this.#pending += text;
      this.#pendingBytes = bytes;
      return { kind: "send", text: "", opens: [] };
    }
    const rest = text.slice(end + 1);
    const restBytes = utf8Length(rest);
    if (restBytes > HUB_LINE_MAX_BYTES) return this.#refuse(OVERSIZED);
    let out = "";
    let sent = this.#sent;
    const opens: HubOpen[] = [];
    for (const line of (this.#pending + text.slice(0, end)).split("\n")) {
      const d = decideHubRequest(line, caller, sent);
      if (d.kind === "refuse") return this.#refuse(d.refusal);
      if (d.kind === "open") {
        opens.push({ argv: d.argv, url: d.url });
        continue;
      }
      out += `${line}\n`;
      sent = true;
    }
    this.#pending = rest;
    this.#pendingBytes = restBytes;
    this.#sent = sent;
    return { kind: "send", text: out, opens };
  }

  #refuse(refusal: HubRefusal): HubWrite {
    this.#ended = true;
    this.#pending = "";
    this.#pendingBytes = 0;
    return { kind: "refuse", refusal };
  }
}
