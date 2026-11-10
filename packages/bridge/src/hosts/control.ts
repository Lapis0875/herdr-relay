/**
 * The bridge end of the mod-host control channel (DESIGN-v2 §1.5): one TCP listener on `127.0.0.1` for every host,
 * NDJSON (one JSON object per `\n`-terminated UTF-8 line, at most `CONTROL_MAX_LINE_BYTES` including the `\n`).
 *
 * A connection must send a valid `hello` carrying a token the supervisor minted for one spawn, that spawn's folder and
 * process id, within `CONTROL_HELLO_TIMEOUT_MS`; otherwise it is dropped. A token authenticates exactly one connection
 * (it is spent on use and revoked when its process exits). A mod can reach this port (it is inside its `--allow-net`),
 * so failed attempts are reported to the supervisor — attributed to a folder by a spent token or by a live host's pid
 * — which kills a host that keeps trying (S18). Writes go through one queue per connection and are written completely
 * (a partial `Conn.write` corrupted NDJSON in the spike [M]). Migrated from the Deno spike's ctl listener
 * (`docs/spikes/deno.md`).
 */

import {
  type BridgeToHost,
  CONTROL_HELLO_TIMEOUT_MS,
  CONTROL_MAX_LINE_BYTES,
  decodeHostToBridge,
  type HostToBridge,
  type ValidationError,
} from "@herdr-relay/protocol";
import { CoreError, messageOf } from "../core/errors.ts";
import { LineReader } from "../core/frames.ts";

/** Longest first line before authentication; a `hello` is about 150 bytes. */
export const HELLO_MAX_BYTES = 4096;
/** Unauthenticated connections held at once; more are closed on accept. */
export const MAX_PENDING_CONNECTIONS = 64;
/** Bytes queued towards one host before its connection is dropped as not reading. */
export const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
/** Spent tokens remembered for attributing reuse attempts. */
const SPENT_TOKENS_KEPT = 1024;

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Receives what arrives on one authenticated connection. */
export interface ControlPeer {
  /** One validated message (never `hello`). */
  message(msg: HostToBridge): void;
  /** A line that failed validation, with the `t` and `copy` it claimed when readable. */
  invalid(t: string | null, copy: string | null, errors: readonly ValidationError[]): void;
  /** The connection ended: `reason` is null for a clean end of stream, else why it was dropped. Called once. */
  closed(reason: string | null): void;
}

/** One spawn the supervisor is waiting for. */
export interface Expectation {
  folder: string;
  pid: number;
  /** Called once, synchronously, with the authenticated connection; returns where its messages go. */
  accepted(conn: ControlConnection): ControlPeer;
}

export interface ControlServerOptions {
  log?: (message: string) => void;
  /** A connection that did not authenticate; `folder` when it could be attributed to a host. */
  rejected?: (folder: string | null, reason: string) => void;
  /** The folder of a live host process, for attributing a failed `hello` by the pid it claims. */
  folderOfPid?: (pid: number) => string | null;
}

/** Constant-time string equality (tokens). */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function shut(conn: Deno.Conn): void {
  try {
    conn.close();
  } catch {
    // already closed
  }
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  for (let off = 0; off < bytes.length;) off += await conn.write(bytes.subarray(off));
}

/** Top-level fields of a JSON line that failed validation (for attribution and logs only); undefined when absent. */
function claimedFields(text: string, ...keys: string[]): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return keys.map(() => undefined);
  }
  const object = value !== null && typeof value === "object" ? value : null;
  return keys.map((key) => (object !== null && Object.hasOwn(object, key) ? Reflect.get(object, key) : undefined));
}

/** Whether `LineReader` refused a line for its length. */
const overLong = (e: unknown) => e instanceof CoreError && e.kind === "protocol";

/** Runs a peer callback; a throwing receiver is logged and never ends the connection. */
function guarded(log: (message: string) => void, folder: string, what: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    log(`${folder}: handling ${what} failed: ${messageOf(e)}`);
  }
}

/** A fresh token for one spawn: 32 random bytes, hex. */
export function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The listener shared by all hosts. */
export class ControlServer {
  readonly port: number;
  readonly #listener: Deno.TcpListener;
  readonly #options: ControlServerOptions;
  readonly #log: (message: string) => void;
  readonly #expected = new Map<string, Expectation>();
  /** Token → folder, for tokens that were used or revoked. */
  readonly #spent = new Map<string, string>();
  readonly #live = new Set<ControlConnection>();
  #pending = 0;
  #closed = false;

  private constructor(listener: Deno.TcpListener, options: ControlServerOptions) {
    this.#listener = listener;
    this.port = (listener.addr as Deno.NetAddr).port;
    this.#options = options;
    this.#log = options.log ?? ((message) => console.error(`herdr-relay control: ${message}`));
    this.#accept();
  }

  /** Listens on `127.0.0.1` at an ephemeral port. */
  static listen(options: ControlServerOptions = {}): ControlServer {
    return new ControlServer(Deno.listen({ hostname: "127.0.0.1", port: 0 }), options);
  }

  /** Accepts one connection presenting `token`; the returned function revokes the token (e.g. its process exited). */
  expect(token: string, expectation: Expectation): () => void {
    this.#expected.set(token, expectation);
    return () => {
      if (this.#expected.delete(token)) this.#spend(token, expectation.folder);
    };
  }

  /** Stops listening and drops every connection. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#listener.close();
    } catch {
      // already closed
    }
    for (const c of this.#live) c.close("control server closed");
    this.#expected.clear();
  }

  #spend(token: string, folder: string): void {
    this.#spent.set(token, folder);
    if (this.#spent.size > SPENT_TOKENS_KEPT) this.#spent.delete(this.#spent.keys().next().value!);
  }

  async #accept(): Promise<void> {
    for (;;) {
      let conn: Deno.TcpConn;
      try {
        conn = await this.#listener.accept();
      } catch (e) {
        if (!this.#closed) this.#log(`accept failed: ${messageOf(e)}`);
        return;
      }
      if (this.#pending >= MAX_PENDING_CONNECTIONS) {
        shut(conn);
        this.#reject(null, `over ${MAX_PENDING_CONNECTIONS} unauthenticated connections`);
        continue;
      }
      this.#serve(conn);
    }
  }

  #reject(folder: string | null, reason: string): void {
    this.#log(`dropped a connection${folder ? ` attributed to ${folder}` : ""}: ${reason}`);
    this.#options.rejected?.(folder, reason);
  }

  async #serve(conn: Deno.TcpConn): Promise<void> {
    this.#pending++;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      shut(conn);
    }, CONTROL_HELLO_TIMEOUT_MS);
    const reader = conn.readable.getReader();
    const lines = new LineReader(HELLO_MAX_BYTES - 1);
    const got: { line?: Uint8Array; rest?: Uint8Array } = {};
    let problem: string | null = null;
    try {
      while (got.line === undefined) {
        const { value, done } = await reader.read();
        if (done) break;
        const used = lines.push(value, (line) => {
          got.line = line;
          return false;
        });
        if (got.line !== undefined) got.rest = value.subarray(used);
      }
    } catch (e) {
      problem = timedOut ? null : overLong(e) ? `first line over ${HELLO_MAX_BYTES} bytes` : messageOf(e);
    }
    clearTimeout(timer);
    this.#pending--;
    if (got.line === undefined) {
      reader.releaseLock();
      shut(conn);
      this.#reject(
        null,
        timedOut ? `no hello within ${CONTROL_HELLO_TIMEOUT_MS} ms` : problem ?? "closed before hello",
      );
      return;
    }
    const verdict = this.#authenticate(got.line);
    if ("refused" in verdict) {
      reader.releaseLock();
      shut(conn);
      this.#reject(verdict.folder, verdict.refused);
      return;
    }
    const { expectation } = verdict;
    const control = new ControlConnection(conn, expectation.folder, expectation.pid, this.#log, () => {
      this.#live.delete(control);
    });
    this.#live.add(control);
    let peer: ControlPeer;
    try {
      peer = expectation.accepted(control);
    } catch (e) {
      this.#log(`${expectation.folder}: accepting the connection failed: ${messageOf(e)}`);
      reader.releaseLock();
      control.close("not accepted");
      return;
    }
    control.start(reader, peer, got.rest ?? new Uint8Array(0));
  }

  #authenticate(line: Uint8Array): { expectation: Expectation } | { refused: string; folder: string | null } {
    let text: string;
    try {
      text = utf8.decode(line);
    } catch {
      return { refused: "first line is not UTF-8", folder: null };
    }
    const r = decodeHostToBridge(text);
    if (!r.ok || r.value.t !== "hello") {
      const [pid] = claimedFields(text, "pid");
      const folder = typeof pid === "number" ? this.#options.folderOfPid?.(pid) ?? null : null;
      return { refused: "first line is not a valid hello", folder };
    }
    const hello = r.value;
    let token: string | null = null;
    let expectation: Expectation | null = null;
    for (const [t, e] of this.#expected) {
      if (sameToken(t, hello.token)) {
        token = t;
        expectation = e;
      }
    }
    if (token === null || expectation === null) {
      let spentBy: string | null = null;
      for (const [t, folder] of this.#spent) if (sameToken(t, hello.token)) spentBy = folder;
      return {
        refused: spentBy ? "token already used" : "unknown token",
        folder: spentBy ?? this.#options.folderOfPid?.(hello.pid) ?? null,
      };
    }
    this.#expected.delete(token);
    this.#spend(token, expectation.folder);
    if (hello.folder !== expectation.folder || hello.pid !== expectation.pid) {
      return {
        refused:
          `hello claims ${hello.folder} pid ${hello.pid}, token is for ${expectation.folder} pid ${expectation.pid}`,
        folder: expectation.folder,
      };
    }
    return { expectation };
  }
}

/** One authenticated host connection: ordered complete writes, validated reads. */
export class ControlConnection {
  readonly folder: string;
  readonly pid: number;
  readonly #conn: Deno.Conn;
  readonly #log: (message: string) => void;
  readonly #forget: () => void;
  #peer: ControlPeer | null = null;
  #queue: Promise<void> = Promise.resolve();
  #queued = 0;
  #closed = false;
  #reason: string | null = null;

  constructor(conn: Deno.Conn, folder: string, pid: number, log: (message: string) => void, forget: () => void) {
    this.#conn = conn;
    this.folder = folder;
    this.pid = pid;
    this.#log = log;
    this.#forget = forget;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Bytes accepted by `send` and not written yet. */
  get queuedBytes(): number {
    return this.#queued;
  }

  /**
   * Queues one message. False when the connection is closed or the line is over the limit (then nothing is sent);
   * a host that stops reading is dropped once `MAX_QUEUED_BYTES` are waiting.
   */
  send(msg: BridgeToHost): boolean {
    if (this.#closed) return false;
    const bytes = encoder.encode(JSON.stringify(msg) + "\n");
    if (bytes.length > CONTROL_MAX_LINE_BYTES) {
      this.#log(`${this.folder}: not sending a ${msg.t} of ${bytes.length} bytes (over the control line limit)`);
      return false;
    }
    if (this.#queued + bytes.length > MAX_QUEUED_BYTES) {
      this.close(`over ${MAX_QUEUED_BYTES} bytes queued: the host is not reading`);
      return false;
    }
    this.#queued += bytes.length;
    this.#queue = this.#queue
      .then(() => (this.#closed ? undefined : writeAll(this.#conn, bytes)))
      .catch((e) => this.close(`write failed: ${messageOf(e)}`))
      .finally(() => {
        this.#queued -= bytes.length;
      });
    return true;
  }

  /** Drops the connection; the peer's `closed` receives `reason`. */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#reason = reason;
    shut(this.#conn);
    if (this.#peer === null) this.#forget();
  }

  /** Starts reading after `hello`; `rest` holds the bytes that followed it in the same read. */
  async start(reader: ReadableStreamDefaultReader<Uint8Array>, peer: ControlPeer, rest: Uint8Array): Promise<void> {
    this.#peer = peer;
    const lines = new LineReader(CONTROL_MAX_LINE_BYTES - 1);
    const receive = (line: Uint8Array) => {
      if (!this.#closed) this.#line(line, peer);
    };
    let failure: string | null = null;
    try {
      if (rest.length > 0) lines.push(rest, receive);
      while (!this.#closed) {
        const { value, done } = await reader.read();
        if (done) break;
        lines.push(value, receive);
      }
    } catch (e) {
      failure = overLong(e)
        ? `a line over the ${CONTROL_MAX_LINE_BYTES}-byte control limit`
        : `read failed: ${messageOf(e)}`;
    }
    const reason = this.#closed ? this.#reason : failure;
    if (!this.#closed) {
      this.#closed = true;
      shut(this.#conn);
    }
    this.#forget();
    guarded(this.#log, this.folder, "closed", () => peer.closed(reason));
  }

  #line(line: Uint8Array, peer: ControlPeer): void {
    let text: string;
    try {
      text = utf8.decode(line);
    } catch {
      this.#log(`${this.folder}: ignored a line that is not UTF-8`);
      return;
    }
    const r = decodeHostToBridge(text);
    if (r.ok) {
      if (r.value.t === "hello") this.#log(`${this.folder}: ignored a second hello`);
      else guarded(this.#log, this.folder, r.value.t, () => peer.message(r.value));
      return;
    }
    const [t, copy] = claimedFields(text, "t", "copy");
    guarded(this.#log, this.folder, "invalid", () => {
      peer.invalid(typeof t === "string" ? t : null, typeof copy === "string" ? copy : null, r.errors);
    });
  }
}
