/**
 * `net` for mods (DESIGN.md §1.2, DESIGN-v2 §4 T09, SECURITY S16): the mod host has no network beyond its control
 * port, so the bridge opens the TCP connection — to `127.0.0.1` and only to the cockpit hub's port as the hub's
 * `hub.json` names it now (`<cockpit.json cache>/hub.json`, read by the bridge itself), and only for a folder whose
 * policy profile enables `net` (OSS-PLAN §1) — and relays bytes: `net.connect` → a connection id, `net.write`,
 * `net.read` (base64, `null` at the end of the stream), `net.close`. A connection belongs to the mod folder that
 * opened it; connections of an older host generation are closed when a newer one of that folder makes a call. Every
 * connect is logged (rule `net`, with the folder's profile).
 *
 * Writes are decided for the origin of the call (the device session the view manager resolved, D3) under the
 * folder's `net.writes` (`../policy/profiles.ts` `netWriteMode`): `act` sends a write only for a connected device with
 * `act` scope (a mod's own task and a `read` device write nothing); `cockpit-hub` reads the writes as the hub's
 * requests and sends only what `../policy/hub.ts` admits — reads for anyone, actions for a connected `act` device,
 * changes only the Herdr window makes for no one, `open_url` answered by the bridge (a link on the device, U3). A
 * refused write sends nothing, is logged (rule `net`, with the folder's profile; an `open_url` answered as `intercept`),
 * toasts the connected device when there is something to tell it, rejects with the reason and closes the connection.
 *
 * Reads and writes are independent lanes, each in call order, and a write never waits behind a pending read (a mod may
 * keep a read open in the background and write when the person acts, on the same socket). Reads take the connection's
 * bytes in the order they came — the answers the bridge gives itself (an `open_url`) and the hub's, fetched by one
 * `tcp.read` at a time while a read waits — so an answer the bridge gives while a read waits answers that read at once,
 * and what the `tcp.read` in flight then brings is kept for the next read. A failed read or write closes the
 * connection; closing it ends both lanes, and every call on it then rejects.
 */

import { join } from "@std/path";
import {
  DEFAULT_PROFILE_ID,
  type NetWriteMode,
  type PolicyDecision,
  type PolicyProfile,
  type Toast,
} from "@herdr-relay/protocol";
import {
  type CockpitInstall,
  logDecision,
  netWriteMode,
  type PolicyLog,
  refuse,
  USER_DECISIONS,
  type UserDecisions,
} from "../policy/mod.ts";
import { type HubRefusal, HubStream, needsActRefusal, openLinkToast } from "../policy/hub.ts";
import { hubOpenedReply } from "../policy/hub.table.ts";
import type { ResolvedOrigin } from "../views/mod.ts";
import { readJson } from "./files.ts";

/** Connections one mod folder may hold open. */
export const MAX_NET_PER_FOLDER = 16;
/** Largest `net.read` answer. */
export const NET_READ_MAX_BYTES = 1024 * 1024;

/** A `net.read` waiting for bytes. */
interface Waiter {
  /** Its `maxBytes`. */
  readonly max: number;
  /** Answers it: its bytes, or null when the hub ended the stream. */
  readonly resolve: (chunk: Uint8Array | null) => void;
  readonly reject: (reason: Error) => void;
}

interface Conn {
  readonly id: string;
  readonly folder: string;
  readonly generation: number;
  readonly tcp: Deno.TcpConn;
  /** The requests written so far when the folder's `net.writes` is `cockpit-hub`; null: `act`. */
  readonly requests: HubStream | null;
  /** Bytes no read has taken yet, in the order they came: the bridge's own answers (an `open_url`) and the hub's. */
  readonly inbox: Uint8Array[];
  /** Reads waiting for bytes, in call order (only while `inbox` is empty and the stream has not ended). */
  readonly waiting: Waiter[];
  /** The one `tcp.read` is in flight (started while a read waits). */
  pulling: boolean;
  /** The hub ended the stream: once `inbox` is empty, every read answers null. */
  ended: boolean;
  /** The last write in call order (writes run one at a time, beside the reads). */
  writes: Promise<unknown>;
  closed: boolean;
}

/** `bytes` as base64 (a `net.read` answer). */
function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** What a call on a closed connection (or one closed while it waited or ran) rejects with. */
const closedError = () => new Error("the connection is closed");

export interface HubProxyOptions {
  /** cockpit's install record (`<appHome>/cockpit.json`), read by the bridge. */
  cockpit(): CockpitInstall | null;
  /** The policy profile governing a folder (`net.hubPortFrom` enables the hub connection, `net.writes` its writes). */
  profileFor(folder: string): PolicyProfile;
  policyLog: PolicyLog;
  log: (line: string) => void;
  /** Shows a toast on one device session (a refusal, an `open_url` link); false when that session is gone. */
  toast?: (session: string, toast: Toast) => boolean;
  /** U3 `openUrlOnDevice` (default: the confirmed `USER_DECISIONS`). */
  decisions?: UserDecisions;
}

export class HubProxy {
  readonly #o: HubProxyOptions;
  readonly #conns = new Map<string, Conn>();
  #seq = 0;

  constructor(o: HubProxyOptions) {
    this.#o = o;
  }

  /** `net.connect(host, port)` from `folder`'s host `generation`, for `session` (logged). */
  async connect(folder: string, generation: number, host: unknown, port: unknown, session?: string): Promise<string> {
    this.#sweep(folder, generation);
    const argv = [String(host), String(port)];
    const profile = this.#o.profileFor(folder);
    const decide = (decision: "allow" | "refuse", reason?: string) =>
      logDecision(this.#o.policyLog, {
        folder,
        method: "net.connect",
        argv,
        decision,
        rule: "net",
        reason,
        session,
        profile: profile.id,
      });
    let mode: NetWriteMode;
    try {
      if (profile.id === DEFAULT_PROFILE_ID) refuse("net", `no profile for ${folder}: net is off`);
      const enabled = netWriteMode(profile);
      if (enabled === null) refuse("net", `net is not enabled for ${folder} (profile ${profile.id})`);
      mode = enabled;
      if (host !== "127.0.0.1" && host !== "localhost") refuse("net", "mods may only connect to 127.0.0.1");
      const hub = await this.#hubPort();
      if (hub === null) refuse("net", "the cockpit hub has no address (hub.json)");
      if (port !== hub) refuse("net", "mods may only connect to the cockpit hub's port");
      if ([...this.#conns.values()].filter((c) => c.folder === folder).length >= MAX_NET_PER_FOLDER) {
        refuse("net", `a mod may hold at most ${MAX_NET_PER_FOLDER} connections`);
      }
    } catch (e) {
      decide("refuse", e instanceof Error ? e.message : String(e));
      throw e;
    }
    decide("allow");
    const tcp = await Deno.connect({ hostname: "127.0.0.1", port: port as number });
    const id = `net-${++this.#seq}`;
    this.#conns.set(id, {
      id,
      folder,
      generation,
      tcp,
      requests: mode === "cockpit-hub" ? new HubStream() : null,
      inbox: [],
      waiting: [],
      pulling: false,
      ended: false,
      writes: Promise.resolve(),
      closed: false,
    });
    return id;
  }

  /**
   * `net.write(id, text)` for `origin` (null: none): the UTF-8 bytes of what the folder's `net.writes` admits of
   * `text`, decided in write order (module comment). A refused write rejects with the reason and closes the connection.
   */
  write(folder: string, generation: number, id: unknown, data: unknown, origin: ResolvedOrigin | null): Promise<void> {
    const c = this.#own(folder, generation, id);
    if (typeof data !== "string") refuse("net", "net.write takes text");
    return this.#queued(c, async () => {
      const bytes = new TextEncoder().encode(this.#admit(c, data, origin));
      for (let off = 0; off < bytes.length;) off += await c.tcp.write(bytes.subarray(off));
    });
  }

  /**
   * `net.read(id, maxBytes)`: up to `maxBytes` (base64) of the connection's bytes in the order they came (module
   * comment), or null when the hub closed the connection.
   */
  read(folder: string, generation: number, id: unknown, maxBytes: unknown): Promise<string | null> {
    const c = this.#own(folder, generation, id);
    const max = typeof maxBytes === "number" && Number.isInteger(maxBytes) && maxBytes > 0
      ? Math.min(maxBytes, NET_READ_MAX_BYTES)
      : 65536;
    const read = Promise.withResolvers<Uint8Array | null>();
    c.waiting.push({ max, resolve: read.resolve, reject: read.reject });
    this.#serve(c);
    return read.promise.then((chunk) => chunk === null ? null : base64(chunk));
  }

  /** `net.close(id)` (an emit: nothing to answer; another folder's id is ignored). */
  close(folder: string, id: unknown): void {
    const c = typeof id === "string" ? this.#conns.get(id) : undefined;
    if (c && c.folder === folder) this.#drop(c);
  }

  /** Closes every connection (bridge shutdown). */
  closeAll(): void {
    for (const c of [...this.#conns.values()]) this.#drop(c);
  }

  #own(folder: string, generation: number, id: unknown): Conn {
    this.#sweep(folder, generation);
    const c = typeof id === "string" ? this.#conns.get(id) : undefined;
    if (!c || c.folder !== folder) refuse("net", "no such connection");
    return c;
  }

  /**
   * What of `data` goes to the hub for `origin`: the text to send (possibly empty). A refusal is logged, toasted on the
   * connected device it names one for, and thrown (the lane then closes the connection). An `open_url` sends its link
   * to the device and gives the bridge's answer to the connection's reads (a waiting read takes it at once).
   */
  #admit(c: Conn, data: string, origin: ResolvedOrigin | null): string {
    const device = origin?.connected ? origin.scope : null;
    const record = (decision: PolicyDecision, argv: string[], reason?: string) =>
      logDecision(this.#o.policyLog, {
        folder: c.folder,
        method: "net.write",
        argv,
        decision,
        rule: "net",
        reason,
        session: origin?.session,
        profile: this.#o.profileFor(c.folder).id,
      });
    const refused = (r: HubRefusal): never => {
      record("refuse", r.argv, r.reason);
      if (r.toast !== undefined && origin?.connected) this.#o.toast?.(origin.session, r.toast);
      return refuse("net", r.reason);
    };
    if (c.requests === null) {
      if (device !== "act") refused(needsActRefusal("Writing to the cockpit hub", [], device));
      return data;
    }
    const w = c.requests.write(data, {
      device,
      openUrlOnDevice: (this.#o.decisions ?? USER_DECISIONS).openUrlOnDevice,
    });
    if (w.kind === "refuse") return refused(w.refusal);
    const replies: Uint8Array[] = [];
    for (const open of w.opens) {
      const shown = origin?.connected === true && (this.#o.toast?.(origin.session, openLinkToast(open.url)) ?? false);
      if (!shown) refused({ argv: open.argv, reason: "no device to open the link on" });
      record("intercept", open.argv);
      replies.push(new TextEncoder().encode(hubOpenedReply(open.url)));
    }
    if (replies.length > 0) {
      c.inbox.push(...replies);
      this.#serve(c);
    }
    return w.text;
  }

  /**
   * Answers the waiting reads in call order from `inbox` (each takes up to its `maxBytes` of the oldest bytes), and
   * starts the one `tcp.read` when a read still waits for the hub.
   */
  #serve(c: Conn): void {
    for (let w = c.waiting[0]; w !== undefined; w = c.waiting[0]) {
      const head = c.inbox[0];
      if (head === undefined && !c.ended) {
        if (!c.pulling) this.#pull(c, w.max);
        return;
      }
      c.waiting.shift();
      if (head === undefined) {
        w.resolve(null);
        continue;
      }
      const chunk = head.subarray(0, w.max);
      if (chunk.length === head.length) c.inbox.shift();
      else c.inbox[0] = head.subarray(chunk.length);
      w.resolve(chunk);
    }
  }

  /**
   * The one `tcp.read` in flight, of up to `max` bytes: what it brings joins `inbox` for the waiting reads (or the next
   * read, when the bridge answered the waiting one meanwhile). A failure rejects the oldest waiting read with it and
   * closes the connection; once the connection is closed, its outcome is ignored.
   */
  #pull(c: Conn, max: number): void {
    c.pulling = true;
    const buf = new Uint8Array(max);
    c.tcp.read(buf).then((n) => {
      c.pulling = false;
      if (c.closed) return;
      if (n === null) c.ended = true;
      else c.inbox.push(buf.subarray(0, n));
      this.#serve(c);
    }, (e: unknown) => {
      c.pulling = false;
      if (c.closed) return;
      c.waiting.shift()?.reject(e instanceof Error ? e : new Error(String(e)));
      this.#drop(c);
    });
  }

  /**
   * Runs `op` after the earlier writes on the connection. A failing write closes the connection; a write of a closed
   * connection rejects with {@link closedError} instead of running.
   */
  #queued(c: Conn, op: () => Promise<void>): Promise<void> {
    const run = c.writes.then(async () => {
      if (c.closed) throw closedError();
      try {
        return await op();
      } catch (e) {
        throw c.closed ? closedError() : e;
      }
    });
    c.writes = run.catch(() => this.#drop(c));
    return run;
  }

  /** Connections an older host generation of `folder` left open are closed. */
  #sweep(folder: string, generation: number): void {
    for (const c of [...this.#conns.values()]) if (c.folder === folder && c.generation < generation) this.#drop(c);
  }

  #drop(c: Conn): void {
    c.closed = true;
    if (!this.#conns.delete(c.id)) return;
    c.inbox.length = 0;
    for (const w of c.waiting.splice(0)) w.reject(closedError());
    try {
      c.tcp.close();
    } catch {
      // already closed
    }
  }

  async #hubPort(): Promise<number | null> {
    const cache = this.#o.cockpit()?.cache;
    if (typeof cache !== "string" || !cache.startsWith("/")) return null;
    const info = await readJson(join(cache, "hub.json"), this.#o.log, 64 * 1024);
    const port = typeof info === "object" && info !== null && "port" in info ? info.port : undefined;
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  }
}
