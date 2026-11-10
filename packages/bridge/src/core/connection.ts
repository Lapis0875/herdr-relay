/**
 * One herdr-core connection over a {@link CoreTransport}: JSON-RPC 2.0, plain mode for `hello` only, then
 * generation-1 frames (`frames.ts`). It never reconnects — {@link CoreClient} does that by opening a new one.
 *
 * Safety properties this file owns:
 * - only {@link CORE_METHODS} can be called (read-only methods plus `terminal.attach`);
 * - nothing here ever encodes a RESIZE or FOCUS frame: an attach never resizes the Mac's terminal;
 * - typed bytes go out only on a stream attached in `type` mode;
 * - a dropped connection rejects every in-flight call and ends every stream; nothing is retried or replayed.
 */

import {
  checkAttach,
  checkHello,
  checkNotification,
  checkSchema,
  checkSnapshot,
  isRecord,
  versionAtLeast,
} from "./checks.ts";
import { CoreError, messageOf } from "./errors.ts";
import {
  CONTROL_CHANNEL,
  decodeResize,
  encodeCredit,
  encodeFrame,
  FRAME,
  FrameReader,
  LineReader,
  MAX_FRAME,
  MAX_LINE,
} from "./frames.ts";
import type { CoreTransport } from "./transport.ts";
import {
  CORE_GENERATION,
  CORE_METHODS,
  CORE_MINIMUM_VERSION,
  type CoreAttachResult,
  type CoreHello,
  type CoreMethod,
  type CoreNotification,
  type CoreSchema,
  type CoreSnapshot,
  type CoreTerminal,
} from "./types.ts";

/** Per-call answer deadline unless the caller gives one (herdr-core's own default, DESIGN.md §4). */
export const DEFAULT_CALL_TIMEOUT_MS = 15_000;
/** Calls in flight per connection. */
export const MAX_PENDING_CALLS = 256;
/** Largest single `input()` on a typing stream. */
export const MAX_INPUT_BYTES = 256 * 1024;
/** Bytes queued towards the core before the connection is dropped as `slow`. */
export const MAX_QUEUED_BYTES = 2 * MAX_FRAME;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const NEWLINE = 10;

export type AttachMode = "observe" | "type";

/** How a stream ended. */
export interface CoreStreamEnd {
  /** The core sent CLOSE (`core`), it acknowledged this side's `close()` (`client`), or the connection dropped. */
  by: "core" | "client" | "disconnect";
  /** The core's CLOSE payload (parsed JSON, text, or null when empty), or the {@link CoreError} of the drop. */
  detail: unknown;
}

/** A terminal stream from `terminal.attach`. */
export interface TerminalStream {
  /** The terminal as requested (`t7`, a name, or `machine/t7`). */
  readonly terminal: string;
  readonly channel: number;
  readonly mode: AttachMode;
  /** The viewer size sent with the attach: the terminal's own size read just before. */
  readonly cols: number;
  readonly rows: number;
  /** `AttachResult.terminal`: the terminal's facts at attach time. */
  readonly facts: CoreTerminal;
  /** The whole path sends RESIZE before replacement paints (only when requested on an observe stream). */
  readonly resizeNotifications: boolean;
  /** `AttachResult.automatic_input` (informational; typed bytes are always sent as DATA, i.e. from a person). */
  readonly automaticInput: boolean;
  /** Settles once the stream is over (never rejects). */
  readonly closed: Promise<CoreStreamEnd>;
  /** Sends typed bytes. Throws `CoreError("refused")` on an observe stream, `disconnected` once closed. */
  input(bytes: Uint8Array): void;
  /** Asks the core to end the stream; output still in flight is dropped. Idempotent. */
  close(): void;
}

export interface AttachRequest {
  terminal: string;
  cols: number;
  rows: number;
  mode: AttachMode;
  /** Scrollback lines to paint first (main screen only). */
  history?: number;
  /** Observe only: ask for RESIZE frames before replacement paints (`onResize`). */
  resizeNotifications?: boolean;
  /** Terminal bytes, first paint then live output. A throwing handler ends the stream. */
  onData?: (bytes: Uint8Array) => void;
  /** New terminal size announced by the core (needs `resizeNotifications`). */
  onResize?: (size: { cols: number; rows: number }) => void;
  timeout?: number;
}

export interface CallOptions {
  timeout?: number;
  /**
   * Runs synchronously when the answer is parsed, before any later frame in the same read: registers a stream
   * channel before its first DATA frame. Throwing rejects the call.
   */
  onResult?: (result: unknown) => void;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: CoreError): void;
  timer: ReturnType<typeof setTimeout>;
  onResult?: (result: unknown) => void;
}

interface StreamSink {
  data(bytes: Uint8Array): void;
  close(end: CoreStreamEnd): void;
  resize?(cols: number, rows: number): void;
}

export class CoreConnection {
  readonly transport: CoreTransport;
  /** Settles with the error that ended the connection (never rejects). */
  readonly ended: Promise<CoreError>;
  /** Settles once the read loop stopped and the transport is gone (child exited). */
  readonly finished: Promise<void>;

  readonly #log: (message: string) => void;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #frames = new FrameReader();
  readonly #plain = new LineReader(MAX_LINE);
  readonly #pending = new Map<number, Pending>();
  readonly #streams = new Map<number, StreamSink>();
  /** Channels this side has sent CLOSE on; their late output is dropped. */
  readonly #closing = new Set<number>();
  #framed = false;
  #helloId = -1;
  #next = 0;
  #queued = 0;
  #error: CoreError | null = null;
  readonly #settleEnded: (error: CoreError) => void;
  #onNotification: ((notification: CoreNotification) => void) | null = null;

  constructor(transport: CoreTransport, options: { log?: (message: string) => void } = {}) {
    this.transport = transport;
    this.#log = options.log ?? (() => {});
    this.#writer = transport.writable.getWriter();
    this.#reader = transport.readable.getReader();
    const ended = Promise.withResolvers<CoreError>();
    this.ended = ended.promise;
    this.#settleEnded = ended.resolve;
    this.finished = this.#pump().then(() => transport.closed).then(() => {});
  }

  /** The error that ended the connection, or null while it is open. */
  get error(): CoreError | null {
    return this.#error;
  }

  /** Calls one allowlisted method. Never retried: a drop rejects it with `disconnected`. */
  call<T = unknown>(method: CoreMethod, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    if (!(CORE_METHODS as readonly string[]).includes(method)) {
      return Promise.reject(new CoreError("refused", `herdr-relay never calls the core method ${method}`));
    }
    if (this.#error) return Promise.reject(this.#error);
    if (!this.#framed && (method !== "hello" || this.#helloId >= 0)) {
      return Promise.reject(new CoreError("protocol", `${method} sent before the connection switched to frames`));
    }
    if (this.#pending.size >= MAX_PENDING_CALLS) {
      return Promise.reject(new CoreError("busy", `${MAX_PENDING_CALLS} core calls are already in flight`));
    }
    const id = ++this.#next;
    const timeout = options.timeout ?? DEFAULT_CALL_TIMEOUT_MS;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new CoreError("timeout", `core ${method} did not answer within ${timeout} ms; its effect is unknown`));
    }, timeout);
    this.#pending.set(id, {
      method,
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
      onResult: options.onResult,
    });
    try {
      const body = encoder.encode(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      if (this.#framed) this.#write(encodeFrame(CONTROL_CHANNEL, FRAME.data, body));
      else {
        this.#helloId = id;
        const line = new Uint8Array(body.length + 1);
        line.set(body);
        line[body.length] = NEWLINE;
        this.#write(line);
      }
    } catch (error) {
      this.#pending.delete(id);
      clearTimeout(timer);
      reject(error instanceof CoreError ? error : new CoreError("protocol", messageOf(error), { cause: error }));
    }
    return promise;
  }

  /**
   * Opens the event stream (all terminals). Notifications arriving on it — or, unexpectedly, on channel 0 — go to
   * `onNotification`. The core closing the stream ends the connection.
   */
  subscribe(onNotification: (notification: CoreNotification) => void, timeout?: number): Promise<CoreSnapshot> {
    this.#onNotification = onNotification;
    const lines = new LineReader(MAX_LINE);
    return this.call<CoreSnapshot>("events.subscribe", {}, {
      timeout,
      onResult: (result) => {
        const snapshot = checkSnapshot(result);
        if (this.#streams.has(snapshot.channel)) {
          throw new CoreError("protocol", `core reused channel ${snapshot.channel} for events`);
        }
        this.#streams.set(snapshot.channel, {
          data: (bytes) => {
            lines.push(bytes, (line) => onNotification(checkNotification(parseJson(line, "event line"))));
          },
          close: (end) => {
            if (end.by !== "disconnect") this.#fail(new CoreError("disconnected", "the core closed the event stream"));
          },
        });
      },
    });
  }

  /** Attaches to a terminal at the given viewer size. `observe` streams can never type; no stream ever resizes. */
  async attach(request: AttachRequest): Promise<TerminalStream> {
    const { terminal, cols, rows, mode } = request;
    if (mode !== "observe" && mode !== "type") throw new CoreError("refused", `unknown attach mode ${String(mode)}`);
    for (const [name, value] of [["cols", cols], ["rows", rows]] as const) {
      if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        throw new CoreError("refused", `attach ${name} ${value} is not a u16`);
      }
    }
    const { promise: closed, resolve: settle } = Promise.withResolvers<CoreStreamEnd>();
    let channel = -1;
    const sink: StreamSink = {
      data: (bytes) => {
        if (!request.onData) return;
        try {
          request.onData(bytes);
        } catch (error) {
          this.#log(`terminal ${terminal} stream handler failed, closing it: ${messageOf(error)}`);
          this.#closeStream(channel);
        }
      },
      close: settle,
    };
    if (request.onResize) {
      const onResize = request.onResize;
      sink.resize = (newCols, newRows) => {
        try {
          onResize({ cols: newCols, rows: newRows });
        } catch (error) {
          this.#log(`terminal ${terminal} resize handler failed: ${messageOf(error)}`);
        }
      };
    }
    const params: Record<string, unknown> = { terminal, cols, rows, observe: mode === "observe" };
    if (request.history) params.history = request.history;
    if (mode === "observe" && request.resizeNotifications) params.resize_notifications = true;
    const result = await this.call<CoreAttachResult>("terminal.attach", params, {
      timeout: request.timeout,
      onResult: (value) => {
        const attached = checkAttach(value);
        if (this.#streams.has(attached.channel)) {
          throw new CoreError("protocol", `core reused channel ${attached.channel} for terminal ${terminal}`);
        }
        channel = attached.channel;
        this.#streams.set(channel, sink);
      },
    });
    return {
      terminal,
      channel,
      mode,
      cols,
      rows,
      facts: result.terminal,
      resizeNotifications: result.resize_notifications === true,
      automaticInput: result.automatic_input === true,
      closed,
      input: (bytes) => this.#input(channel, mode, bytes),
      close: () => this.#closeStream(channel),
    };
  }

  /** Ends the connection with `error` (what in-flight calls and streams see), kills the child, waits until gone. */
  abort(error: CoreError): Promise<void> {
    this.#fail(error);
    return this.finished;
  }

  /** Ends the connection (kills the child) and waits until it is gone. */
  close(): Promise<void> {
    return this.abort(new CoreError("closed", "the core connection was closed"));
  }

  #input(channel: number, mode: AttachMode, bytes: Uint8Array): void {
    if (mode !== "type") throw new CoreError("refused", "an observe stream never types");
    if (this.#error || !this.#streams.has(channel) || this.#closing.has(channel)) {
      throw new CoreError("disconnected", "the terminal stream is closed");
    }
    if (bytes.length > MAX_INPUT_BYTES) {
      throw new CoreError("refused", `terminal input of ${bytes.length} bytes exceeds ${MAX_INPUT_BYTES}`);
    }
    if (bytes.length > 0) this.#write(encodeFrame(channel, FRAME.data, bytes));
  }

  #closeStream(channel: number): void {
    if (this.#error || !this.#streams.has(channel) || this.#closing.has(channel)) return;
    this.#closing.add(channel);
    try {
      this.#write(encodeFrame(channel, FRAME.close));
    } catch { /* the connection failed; #fail ended the stream */ }
  }

  #write(bytes: Uint8Array): void {
    if (this.#error) throw this.#error;
    if (this.#queued + bytes.length > MAX_QUEUED_BYTES) {
      const error = new CoreError("slow", "the core is not reading; its write queue overflowed");
      this.#fail(error);
      throw error;
    }
    this.#queued += bytes.length;
    this.#writer.write(bytes).then(
      () => this.#queued -= bytes.length,
      (error) =>
        this.#fail(
          new CoreError("disconnected", `writing to the core failed: ${messageOf(error)}`, { cause: error }),
        ),
    );
  }

  async #pump(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.#reader.read();
        if (done || this.#error) break;
        this.#receive(value);
      }
      this.#fail(new CoreError("disconnected", "the core connection ended"));
    } catch (error) {
      this.#fail(
        error instanceof CoreError
          ? error
          : new CoreError("disconnected", `reading from the core failed: ${messageOf(error)}`, { cause: error }),
      );
    }
  }

  #receive(chunk: Uint8Array): void {
    if (!this.#framed) {
      const used = this.#plain.push(chunk, (line) => {
        const message = parseJson(line, "message");
        if (isRecord(message) && message.id === this.#helloId && isRecord(message.result)) {
          this.#framed = message.result.framed === true;
        }
        this.#message(message);
        return !this.#framed;
      });
      if (!this.#framed || used === chunk.length) return;
      chunk = chunk.subarray(used);
    }
    this.#frames.push(chunk, this.#frame);
  }

  readonly #frame = (channel: number, kind: number, payload: Uint8Array): void => {
    if (channel === CONTROL_CHANNEL) {
      if (kind !== FRAME.data) throw new CoreError("protocol", `core sent a frame of kind ${kind} on channel 0`);
      this.#message(parseJson(payload, "message"));
      return;
    }
    const sink = this.#streams.get(channel);
    switch (kind) {
      case FRAME.data:
        if (this.#closing.has(channel)) return;
        if (!sink) {
          // A stream this side never registered (its attach answer came after the call timed out): end it.
          this.#log(`closing unexpected core stream ${channel}`);
          this.#closing.add(channel);
          this.#write(encodeFrame(channel, FRAME.close));
          return;
        }
        sink.data(payload);
        if (!this.#error && payload.length > 0) this.#write(encodeCredit(channel, payload.length));
        return;
      case FRAME.close: {
        this.#streams.delete(channel);
        const by = this.#closing.delete(channel) ? "client" : "core";
        sink?.close({ by, detail: closeDetail(payload) });
        return;
      }
      case FRAME.credit:
        if (payload.length !== 4) throw new CoreError("protocol", `core credit of ${payload.length} bytes`);
        return; // the core credits viewer input only implicitly; this side bounds its own write queue
      case FRAME.resize: {
        const size = decodeResize(payload);
        if (size && sink?.resize && !this.#closing.has(channel)) sink.resize(size.cols, size.rows);
        return;
      }
      default:
        return; // FOCUS, FACTS and newer kinds carry nothing this client uses
    }
  };

  #message(message: unknown): void {
    if (!isRecord(message)) throw new CoreError("protocol", "core sent a JSON-RPC message that is not an object");
    const id = message.id;
    if (id === undefined || id === null) {
      if (typeof message.method === "string") this.#onNotification?.(checkNotification(message));
      return;
    }
    const pending = typeof id === "number" ? this.#pending.get(id) : undefined;
    if (!pending) return; // answer to a call that already timed out
    this.#pending.delete(id as number);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(rpcError(pending.method, message.error));
      return;
    }
    try {
      pending.onResult?.(message.result);
    } catch (error) {
      pending.reject(
        error instanceof CoreError ? error : new CoreError("protocol", messageOf(error), { cause: error }),
      );
      return;
    }
    pending.resolve(message.result);
  }

  #fail(error: CoreError): void {
    if (this.#error) return;
    this.#error = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    const streams = [...this.#streams.values()];
    this.#streams.clear();
    this.#closing.clear();
    for (const stream of streams) stream.close({ by: "disconnect", detail: error });
    this.#writer.abort(error).catch(() => {});
    this.#reader.cancel(error).catch(() => {});
    this.transport.close();
    this.#settleEnded(error);
  }
}

/**
 * `hello {generation:1, framed:true}` then `rpc.discover`; checks generation, minimum version, framing and that
 * every {@link CORE_METHODS} entry is both announced and described. Throws `CoreError("incompatible")` otherwise.
 */
export async function negotiate(
  connection: CoreConnection,
  timeout: number = DEFAULT_CALL_TIMEOUT_MS,
): Promise<{ hello: CoreHello; schema: CoreSchema }> {
  let hello: CoreHello;
  try {
    hello = checkHello(
      await connection.call("hello", { generation: CORE_GENERATION, framed: true }, { timeout }),
    );
  } catch (error) {
    if (error instanceof CoreError && error.kind === "unsupported_generation") {
      throw new CoreError(
        "incompatible",
        `herdr-core does not speak protocol generation ${CORE_GENERATION}${error.hint ? ` (${error.hint})` : ""}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (hello.generation !== CORE_GENERATION) {
    throw new CoreError(
      "incompatible",
      `herdr-core ${hello.version} speaks generation ${hello.generation}; herdr-relay speaks ${CORE_GENERATION}`,
    );
  }
  if (!versionAtLeast(hello.version, CORE_MINIMUM_VERSION)) {
    throw new CoreError(
      "incompatible",
      `herdr-relay needs herdr-core ${CORE_MINIMUM_VERSION} or newer; this core is ${hello.version} (run \`hc update\`)`,
    );
  }
  if (!hello.framed) throw new CoreError("incompatible", `herdr-core ${hello.version} did not switch to frames`);
  const missing = CORE_METHODS.filter((method) => !hello.methods.includes(method));
  if (missing.length) {
    throw new CoreError("incompatible", `herdr-core ${hello.version} lacks ${missing.join(", ")}`);
  }
  const schema = checkSchema(await connection.call("rpc.discover", {}, { timeout }));
  const undescribed = CORE_METHODS.filter((method) => !schema.methods.some((entry) => entry.name === method));
  if (undescribed.length) {
    throw new CoreError(
      "incompatible",
      `herdr-core ${schema.info.version} does not describe ${undescribed.join(", ")}`,
    );
  }
  return { hello, schema };
}

function parseJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new CoreError("protocol", `core sent an unreadable ${what}: ${messageOf(error)}`, { cause: error });
  }
}

function closeDetail(payload: Uint8Array): unknown {
  if (payload.length === 0) return null;
  const text = new TextDecoder().decode(payload);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function rpcError(method: string, error: unknown): CoreError {
  if (!isRecord(error)) return new CoreError("rpc", `core ${method} failed`);
  const data = isRecord(error.data) ? error.data : {};
  return new CoreError(
    typeof data.kind === "string" ? data.kind : "rpc",
    typeof error.message === "string" ? error.message : `core ${method} failed`,
    {
      ...(typeof error.code === "number" ? { code: error.code } : {}),
      ...(typeof data.hint === "string" ? { hint: data.hint } : {}),
    },
  );
}
