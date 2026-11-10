/**
 * One device WebSocket (`/herdr-relay/ws`, PROTOCOL.md §1): JSON text frames validated with the protocol package's
 * `t`-discriminated `ClientMessage` schema, binary terminal frames, `hello` first, and `read`-scope refusals applied
 * before the session layer sees a message. Whatever implements {@link SessionHandler} (the view manager and terminal
 * relay) receives only valid, scope-allowed messages of an authenticated device.
 */

import {
  type BridgeMessage,
  type ClientHello,
  type ClientMessage,
  decodeClientMessage,
  type ValidationError,
} from "@herdr-relay/protocol";
import { type DeviceIdentity, scopeRefusal, type Via } from "../auth/mod.ts";

/** Larger client text frames close the socket (1009); client messages are small. */
export const MAX_TEXT_FRAME = 256 * 1024;
/** A socket that has not sent `hello` by then is closed (1008). */
export const HELLO_TIMEOUT_MS = 10_000;

/** What the session layer sees of a device socket. */
export interface SessionConnection {
  /** Session id (random per socket). */
  readonly id: string;
  readonly device: DeviceIdentity;
  readonly via: Via;
  /** Bytes queued but not yet sent (terminal backpressure). */
  readonly bufferedAmount: number;
  /** Sends one bridge message; `false` when the socket is no longer open. */
  send(msg: BridgeMessage): boolean;
  /** Sends one binary terminal frame (`encodeTerminalFrame`); `false` when the socket is no longer open. */
  sendBinary(frame: Uint8Array): boolean;
  close(code?: number, reason?: string): void;
}

/** Client messages after `hello`. */
export type RequestMessage = Exclude<ClientMessage, ClientHello>;

/** The session layer. Calls for one socket arrive in frame order; rejections are logged (and acked when possible). */
export interface SessionHandler {
  /** The device sent its `hello`; the handler answers with the bridge `hello` (and `snapshot`/`view.tree`s). */
  open(conn: SessionConnection, hello: ClientHello): void | Promise<void>;
  message(conn: SessionConnection, msg: RequestMessage): void | Promise<void>;
  /** A binary frame from an `act` device (typed terminal input); never called for `read` devices. */
  binary(conn: SessionConnection, frame: Uint8Array): void | Promise<void>;
  /** Called once for a socket whose `open` was called. */
  close(conn: SessionConnection, code: number, reason: string): void;
}

export interface ConnectionOptions {
  id: string;
  device: DeviceIdentity;
  via: Via;
  handler: SessionHandler;
  log: (line: string) => void;
  /** Called once when the socket is gone (the server's bookkeeping). */
  onGone: (conn: WsConnection) => void;
}

export class WsConnection implements SessionConnection {
  readonly id: string;
  readonly device: DeviceIdentity;
  readonly via: Via;
  readonly #socket: WebSocket;
  readonly #handler: SessionHandler;
  readonly #log: (line: string) => void;
  #opened = false;
  #droppedBinary = false;
  #helloTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(socket: WebSocket, o: ConnectionOptions) {
    this.id = o.id;
    this.device = o.device;
    this.via = o.via;
    this.#socket = socket;
    this.#handler = o.handler;
    this.#log = o.log;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      this.#helloTimer = setTimeout(() => this.close(1008, "no hello"), HELLO_TIMEOUT_MS);
    };
    socket.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") this.#text(ev.data);
      else this.#binary(new Uint8Array(ev.data as ArrayBuffer));
    };
    socket.onclose = (ev: CloseEvent) => {
      clearTimeout(this.#helloTimer);
      if (this.#opened) {
        try {
          this.#handler.close(this, ev.code, ev.reason);
        } catch (e) {
          this.#log(`session ${this.id}: close handler failed: ${errorText(e)}`);
        }
      }
      o.onGone(this);
    };
    socket.onerror = () => {};
  }

  get bufferedAmount(): number {
    return this.#socket.bufferedAmount;
  }

  send(msg: BridgeMessage): boolean {
    if (this.#socket.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(JSON.stringify(msg));
    return true;
  }

  sendBinary(frame: Uint8Array): boolean {
    if (this.#socket.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(frame);
    return true;
  }

  close(code = 1000, reason = ""): void {
    if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
      this.#socket.close(code, reason);
    }
  }

  #text(data: string): void {
    if (data.length > MAX_TEXT_FRAME) return this.close(1009, "message too big");
    const r = decodeClientMessage(data);
    if (!r.ok) {
      if (!this.#opened) return this.close(1008, "expected hello");
      const id = requestId(data);
      this.#log(`session ${this.id}: invalid message: ${describe(r.errors)}`);
      if (id !== null) {
        this.send({ t: "ack", id, ok: false, error: "refused", message: `invalid message: ${describe(r.errors)}` });
      }
      return;
    }
    const msg = r.value;
    if (!this.#opened) {
      if (msg.t !== "hello") return this.close(1008, "expected hello");
      this.#opened = true;
      clearTimeout(this.#helloTimer);
      this.#call(null, () => this.#handler.open(this, msg));
      return;
    }
    if (msg.t === "hello") return this.close(1008, "duplicate hello");
    const refusal = scopeRefusal(this.device.scope, msg);
    if (refusal) {
      this.send(refusal);
      return;
    }
    this.#call("id" in msg ? msg.id : null, () => this.#handler.message(this, msg));
  }

  #binary(frame: Uint8Array): void {
    if (!this.#opened) return this.close(1008, "expected hello");
    if (this.device.scope !== "act") {
      if (!this.#droppedBinary) this.#log(`session ${this.id}: read-only device sent terminal input; dropped`);
      this.#droppedBinary = true;
      return;
    }
    this.#call(null, () => this.#handler.binary(this, frame));
  }

  /** Runs a handler call; a throw or rejection is logged and, for a request with an id, acked as refused. */
  #call(id: number | null, fn: () => void | Promise<void>): void {
    const failed = (e: unknown) => {
      this.#log(`session ${this.id}: handler failed: ${errorText(e)}`);
      if (id !== null) this.send({ t: "ack", id, ok: false, error: "refused", message: "bridge error" });
    };
    try {
      const p = fn();
      if (p instanceof Promise) p.catch(failed);
    } catch (e) {
      failed(e);
    }
  }
}

/** The `id` of an invalid but parseable request, so it can still be acked. */
function requestId(data: string): number | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("id" in value)) return null;
  const id = value.id;
  return typeof id === "number" && Number.isInteger(id) && id >= 0 ? id : null;
}

function describe(errors: ValidationError[]): string {
  const e = errors[0];
  return e ? `${e.path || "/"}: ${e.message}` : "invalid";
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
