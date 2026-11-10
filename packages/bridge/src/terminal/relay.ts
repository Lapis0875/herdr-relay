/**
 * Terminal relay (DESIGN-v2 T11, PROTOCOL.md §1): device sockets ⇄ herdr-core terminal streams over the T03
 * {@link CoreClient}. Modelled on Shepherdr `service/terminal.ts`.
 *
 * - `term.open {terminal, mode}` attaches **observe** at the terminal's own size, announces
 *   `term.size {terminal, channel, cols, rows}` and relays the stream as binary frames `[u32 channel][bytes]`
 *   (`encodeTerminalFrame`). The channel is chosen per socket and stays the same for that terminal until `term.close`;
 *   every `term.size` is followed by a full paint at that size. Acks for `term.open`/`term.close` go out in request
 *   order (one queue per socket).
 * - Size changes: the observe attach asks for RESIZE notifications and announces each new size with `term.size`; on
 *   a path without them a `size` event re-attaches (fresh paint). The remote never resizes (D4).
 * - `mode:"type"` (an `act` device) lets the device's binary frames on that channel type into the terminal. Typing
 *   uses a separate `type` attach at the terminal's own size, opened on the first keystroke and closed after
 *   {@link TYPE_IDLE_MS} without one, on any size change, and before typing at a size it no longer has. A type
 *   attach whose size turns out stale (the terminal changed size between `terminal.get` and the attach,
 *   AMENDMENTS-c1 §T03) is closed before a byte is typed and retried at the new size.
 * - Backpressure: a terminal whose next frame would push the socket's queued bytes past {@link MAX_BUFFERED_BYTES}
 *   (1 MiB) is detached (its stream closed); once the socket drained to {@link RESUME_BUFFERED_BYTES} it re-attaches
 *   with a fresh `term.size` and paint. Terminal bytes are never dropped from the middle of a stream.
 * - herdr-core reconnects: streams re-attach observe-only on `reset`; a stream the core ended (program lost or
 *   finished) re-attaches on `restarted`/`created`. Typed input is never replayed, and keys that arrive while the
 *   core is not connected are dropped rather than delivered late.
 */

import {
  type AckError,
  decodeTerminalFrame,
  encodeTerminalFrame,
  type TermClose,
  type TermOpen,
} from "@herdr-relay/protocol";
import {
  type AttachMode,
  type AttachOptions,
  type CoreClientEvent,
  type CoreClientListener,
  type CoreClientState,
  CoreError,
  type CoreStreamEnd,
  type CoreTerminal,
  MAX_INPUT_BYTES,
  type TerminalStream,
} from "../core/mod.ts";
import type { SessionConnection } from "../server/mod.ts";

/** Bytes a socket may have queued before a terminal's next frame detaches that terminal. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
/** A detached terminal re-attaches once its socket has at most this many bytes queued. */
export const RESUME_BUFFERED_BYTES = 64 * 1024;
/** How often a socket with detached terminals is checked for having drained. */
export const DRAIN_POLL_MS = 100;
/** A type attach ends this long after the last keystroke (Shepherdr: 2 s). */
export const TYPE_IDLE_MS = 2_000;
/** Deadline of one attach, `terminal.get` included. */
export const ATTACH_TIMEOUT_MS = 5_000;
/** Terminals one socket may have open. */
export const MAX_TERMINALS_PER_SOCKET = 16;
/** Terminal requests and input frames queued on one socket before it is closed as flooding. */
export const MAX_PENDING_PER_SOCKET = 256;
/** Type attaches tried while the terminal keeps changing size. */
const TYPE_ATTACH_ATTEMPTS = 3;
/** The `[u32 channel]` before each binary frame's bytes. */
const FRAME_HEADER = 4;

/** What the relay needs of the core client ({@link CoreClient} satisfies it). */
export interface RelayCore {
  /** Typing needs `up`. */
  readonly state: CoreClientState;
  readonly terminals: ReadonlyMap<string, CoreTerminal>;
  on(listener: CoreClientListener): () => void;
  attach(terminal: string, options: AttachOptions): Promise<TerminalStream>;
}

export interface TerminalRelayOptions {
  /** Diagnostics sink. Default: `console.error` with a `herdr-relay: terminal:` prefix. */
  log?: (line: string) => void;
}

interface Size {
  cols: number;
  rows: number;
}

interface Typist {
  stream: TerminalStream;
  idle: ReturnType<typeof setTimeout> | undefined;
}

/** One terminal one socket shows. */
interface Watch {
  readonly socket: Socket;
  /** As the device named it (`term.open.terminal`); `term.size` and `term.close` use it. */
  readonly terminal: string;
  readonly channel: number;
  /** The core's address for it (events use addresses), from the attach result. */
  address: string;
  mode: AttachMode;
  /** The observe stream relayed to the device. */
  stream: TerminalStream | null;
  attaching: Promise<Error | null> | null;
  /** Bumped by every attach and detach; callbacks of an older stream are ignored. */
  generation: number;
  /** The size last announced with `term.size`. */
  size: Size | null;
  /** Detached for backpressure until the socket drains. */
  throttled: boolean;
  typist: Typist | null;
  closed: boolean;
}

interface Socket {
  readonly conn: SessionConnection;
  /** By `term.open.terminal`. */
  readonly watches: Map<string, Watch>;
  readonly channels: Map<number, Watch>;
  nextChannel: number;
  chain: Promise<void>;
  pending: number;
  drain: ReturnType<typeof setInterval> | undefined;
  closed: boolean;
}

export class TerminalRelay {
  readonly #core: RelayCore;
  readonly #log: (line: string) => void;
  readonly #sockets = new Map<SessionConnection, Socket>();
  readonly #off: () => void;

  constructor(core: RelayCore, options: TerminalRelayOptions = {}) {
    this.#core = core;
    this.#log = options.log ?? ((line) => console.error(`herdr-relay: terminal: ${line}`));
    this.#off = core.on((event) => this.#onCore(event));
  }

  /**
   * Handles `term.open` / `term.close`; acks each. Requests of one socket run in order; the promise settles when this
   * one is done and never rejects.
   */
  message(conn: SessionConnection, msg: TermOpen | TermClose): Promise<void> {
    return this.#enqueue(conn, (socket) => msg.t === "term.open" ? this.#open(socket, msg) : this.#close(socket, msg));
  }

  /**
   * A binary frame from the device: typed bytes for the terminal on its channel. Dropped (and logged) unless that
   * terminal was opened in `type` mode by an `act` device. Never rejects.
   */
  input(conn: SessionConnection, frame: Uint8Array): Promise<void> {
    let channel: number;
    let bytes: Uint8Array;
    try {
      ({ channel, bytes } = decodeTerminalFrame(frame));
    } catch {
      return this.#dropInput(conn, `a ${frame.length}-byte binary frame without a channel header`);
    }
    const watch = this.#sockets.get(conn)?.channels.get(channel);
    if (!watch) return this.#dropInput(conn, `input for channel ${channel}, which is not open`);
    if (watch.mode !== "type") return this.#dropInput(conn, `input for ${watch.terminal}, opened observe-only`);
    if (conn.device.scope !== "act") return this.#dropInput(conn, `input for ${watch.terminal} from a read device`);
    if (bytes.length > MAX_INPUT_BYTES) {
      return this.#dropInput(conn, `${bytes.length} bytes of input for ${watch.terminal} (limit ${MAX_INPUT_BYTES})`);
    }
    if (bytes.length === 0) return Promise.resolve();
    return this.#enqueue(conn, () => this.#type(watch, bytes));
  }

  /** The socket is gone: closes its streams. */
  drop(conn: SessionConnection): void {
    const socket = this.#sockets.get(conn);
    if (!socket) return;
    this.#sockets.delete(conn);
    socket.closed = true;
    clearInterval(socket.drain);
    socket.drain = undefined;
    for (const watch of [...socket.watches.values()]) this.#forget(watch);
  }

  /** Stops following the core and closes every stream. */
  dispose(): void {
    this.#off();
    for (const conn of [...this.#sockets.keys()]) this.drop(conn);
  }

  #enqueue(conn: SessionConnection, task: (socket: Socket) => Promise<void>): Promise<void> {
    let socket = this.#sockets.get(conn);
    if (!socket) {
      socket = {
        conn,
        watches: new Map(),
        channels: new Map(),
        nextChannel: 1,
        chain: Promise.resolve(),
        pending: 0,
        drain: undefined,
        closed: false,
      };
      this.#sockets.set(conn, socket);
    }
    if (socket.pending >= MAX_PENDING_PER_SOCKET) {
      this.#log(`session ${conn.id}: ${socket.pending} terminal requests queued; closing the socket`);
      conn.close(1008, "too many terminal requests");
      return Promise.resolve();
    }
    const current = socket;
    current.pending++;
    const run = current.chain
      .then(() => current.closed ? undefined : task(current))
      .catch((error) => this.#log(`session ${conn.id}: terminal request failed: ${messageOf(error)}`))
      .finally(() => current.pending--);
    current.chain = run;
    return run;
  }

  async #open(socket: Socket, msg: TermOpen): Promise<void> {
    const { conn } = socket;
    if (msg.mode === "type" && conn.device.scope !== "act") {
      return ack(conn, msg.id, "read-only-device", "read-only device");
    }
    let watch = socket.watches.get(msg.terminal);
    if (watch) {
      watch.mode = msg.mode;
      if (msg.mode === "observe") this.#stopTyping(watch);
      const error = await this.#attach(watch);
      return error ? ack(conn, msg.id, "refused", attachFailure(msg.terminal, error)) : ack(conn, msg.id);
    }
    if (socket.watches.size >= MAX_TERMINALS_PER_SOCKET) {
      return ack(conn, msg.id, "refused", `at most ${MAX_TERMINALS_PER_SOCKET} terminals per device`);
    }
    watch = {
      socket,
      terminal: msg.terminal,
      channel: socket.nextChannel++,
      address: msg.terminal,
      mode: msg.mode,
      stream: null,
      attaching: null,
      generation: 0,
      size: null,
      throttled: false,
      typist: null,
      closed: false,
    };
    socket.watches.set(watch.terminal, watch);
    socket.channels.set(watch.channel, watch);
    const error = await this.#attach(watch);
    if (error) {
      this.#forget(watch);
      return ack(conn, msg.id, "refused", attachFailure(msg.terminal, error));
    }
    ack(conn, msg.id);
  }

  #close(socket: Socket, msg: TermClose): Promise<void> {
    const watch = socket.watches.get(msg.terminal);
    if (watch) this.#forget(watch);
    ack(socket.conn, msg.id);
    return Promise.resolve();
  }

  /**
   * Attaches the observe stream unless it is attached, attaching or detached for backpressure. Resolves with the
   * failure (never rejects). Bytes that arrive before the attach answer is handled are held until `term.size` is out.
   */
  #attach(watch: Watch): Promise<Error | null> {
    if (watch.closed || watch.stream || watch.throttled) return Promise.resolve(null);
    if (watch.attaching) return watch.attaching;
    const generation = ++watch.generation;
    const early: (Uint8Array | Size)[] = [];
    let live = false;
    const run = async (): Promise<Error | null> => {
      let stream: TerminalStream;
      try {
        stream = await this.#core.attach(watch.terminal, {
          mode: "observe",
          resizeNotifications: true,
          timeoutMs: ATTACH_TIMEOUT_MS,
          onData: (bytes) => {
            if (generation !== watch.generation) return;
            if (live) this.#forward(watch, bytes);
            else early.push(bytes);
          },
          onResize: (size) => {
            if (generation !== watch.generation) return;
            if (live) this.#resized(watch, size);
            else early.push(size);
          },
        });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (generation === watch.generation && !watch.closed) {
          this.#log(`session ${watch.socket.conn.id}: attaching ${watch.terminal} failed: ${failure.message}`);
        }
        return failure;
      }
      if (generation !== watch.generation || watch.closed) {
        stream.close();
        return null;
      }
      watch.stream = stream;
      watch.address = stream.facts.address;
      void stream.closed.then((end) => this.#ended(watch, generation, end));
      // An observe attach never resizes, so the facts carry the size the core paints at.
      this.#announce(watch, { cols: stream.facts.cols, rows: stream.facts.rows });
      for (const item of early.splice(0)) {
        if (generation !== watch.generation) break;
        if (item instanceof Uint8Array) this.#forward(watch, item);
        else this.#resized(watch, item);
      }
      live = true;
      return null;
    };
    const attaching = run().finally(() => {
      if (watch.attaching === attaching) watch.attaching = null;
    });
    watch.attaching = attaching;
    return attaching;
  }

  /** Closes the observe stream (its late output is ignored) so it can be re-attached. */
  #detach(watch: Watch): void {
    watch.generation++;
    const stream = watch.stream;
    watch.stream = null;
    stream?.close();
  }

  #ended(watch: Watch, generation: number, end: CoreStreamEnd): void {
    if (generation !== watch.generation || !watch.stream) return;
    watch.stream = null;
    if (watch.closed) return;
    const why = end.by === "disconnect"
      ? "the core connection dropped"
      : `the core ended it (${JSON.stringify(end.detail ?? "no reason given")})`;
    this.#log(`session ${watch.socket.conn.id}: terminal ${watch.terminal} stream ended: ${why}; re-attaching later`);
  }

  #announce(watch: Watch, size: Size): void {
    watch.size = size;
    if (watch.typist && !sameSize(watch.typist.stream, size)) this.#stopTyping(watch);
    watch.socket.conn.send({
      t: "term.size",
      terminal: watch.terminal,
      channel: watch.channel,
      cols: size.cols,
      rows: size.rows,
    });
  }

  /** A RESIZE from the core: announced when it changes the size (the core also sends one before the first paint). */
  #resized(watch: Watch, size: Size): void {
    if (!watch.size || !sameSize(watch.size, size)) this.#announce(watch, size);
  }

  #forward(watch: Watch, bytes: Uint8Array): void {
    const { conn } = watch.socket;
    const queued = conn.bufferedAmount;
    // A drained socket takes any frame, so one paint larger than the cap cannot detach the terminal forever.
    if (queued > RESUME_BUFFERED_BYTES && queued + FRAME_HEADER + bytes.length > MAX_BUFFERED_BYTES) {
      this.#log(
        `session ${conn.id}: ${queued} bytes queued to the device; detaching ${watch.terminal} until it drains`,
      );
      this.#detach(watch);
      watch.throttled = true;
      this.#watchDrain(watch.socket);
      return;
    }
    conn.sendBinary(encodeTerminalFrame(watch.channel, bytes));
  }

  #watchDrain(socket: Socket): void {
    if (socket.drain !== undefined) return;
    socket.drain = setInterval(() => {
      if (socket.conn.bufferedAmount > RESUME_BUFFERED_BYTES) return;
      clearInterval(socket.drain);
      socket.drain = undefined;
      for (const watch of socket.watches.values()) {
        if (!watch.throttled) continue;
        watch.throttled = false;
        void this.#attach(watch);
      }
    }, DRAIN_POLL_MS);
  }

  async #type(watch: Watch, bytes: Uint8Array): Promise<void> {
    if (watch.closed || watch.mode !== "type") return;
    // Keys typed while herdr-core is away are dropped, never delivered late.
    if (this.#core.state !== "up") {
      this.#log(`session ${watch.socket.conn.id}: herdr-core is ${this.#core.state}; ${bytes.length} bytes dropped`);
      return;
    }
    const facts = this.#core.terminals.get(watch.address);
    if (facts && facts.state !== "live") {
      this.#log(`session ${watch.socket.conn.id}: ${watch.terminal} is ${facts.state}; ${bytes.length} bytes dropped`);
      return;
    }
    if (watch.typist && facts && !sameSize(watch.typist.stream, facts)) this.#stopTyping(watch);
    if (!watch.typist) {
      let typist: Typist;
      try {
        typist = await this.#startTyping(watch);
      } catch (error) {
        this.#log(
          `session ${watch.socket.conn.id}: cannot type into ${watch.terminal}: ${messageOf(error)}; ` +
            `${bytes.length} bytes dropped`,
        );
        return;
      }
      if (watch.closed || watch.mode !== "type") {
        typist.stream.close();
        return;
      }
      watch.typist = typist;
    }
    const typist = watch.typist;
    try {
      typist.stream.input(bytes);
    } catch (error) {
      this.#log(`session ${watch.socket.conn.id}: typing into ${watch.terminal} failed: ${messageOf(error)}`);
      this.#stopTyping(watch);
      return;
    }
    clearTimeout(typist.idle);
    typist.idle = setTimeout(() => {
      if (watch.typist === typist) this.#stopTyping(watch);
    }, TYPE_IDLE_MS);
  }

  /**
   * A `type` attach at the terminal's own size (the core client reads it with `terminal.get` just before). When the
   * terminal changed size meanwhile — a `size` event during the attach, attach facts or the mirror disagreeing with
   * the attached size — the stream is closed before anything is typed and the attach is retried.
   */
  async #startTyping(watch: Watch): Promise<Typist> {
    for (let attempt = 1;; attempt++) {
      const seen: Size[] = [];
      const off = this.#core.on((event) => {
        if (event.type === "event" && event.kind === "size" && matches(watch, event.terminal)) {
          seen.push(sizeOf(event.data));
        }
      });
      let stream: TerminalStream;
      try {
        stream = await this.#core.attach(watch.terminal, { mode: "type", timeoutMs: ATTACH_TIMEOUT_MS });
      } finally {
        off();
      }
      const mirror = this.#core.terminals.get(stream.facts.address);
      const stale = [stream.facts, ...seen, ...(mirror ? [mirror] : [])].find((size) => !sameSize(size, stream));
      if (!stale) {
        const typist: Typist = { stream, idle: undefined };
        void stream.closed.then(() => {
          if (watch.typist !== typist) return;
          clearTimeout(typist.idle);
          watch.typist = null;
        });
        return typist;
      }
      stream.close();
      this.#log(
        `session ${watch.socket.conn.id}: ${watch.terminal} is ${stale.cols}x${stale.rows}, attached for typing at ` +
          `${stream.cols}x${stream.rows}; closed without typing (attempt ${attempt})`,
      );
      if (attempt >= TYPE_ATTACH_ATTEMPTS) {
        throw new CoreError("refused", `${watch.terminal} kept changing size while attaching to type`);
      }
    }
  }

  #stopTyping(watch: Watch): void {
    const typist = watch.typist;
    if (!typist) return;
    watch.typist = null;
    clearTimeout(typist.idle);
    typist.stream.close();
  }

  #forget(watch: Watch): void {
    watch.closed = true;
    this.#detach(watch);
    this.#stopTyping(watch);
    watch.socket.watches.delete(watch.terminal);
    watch.socket.channels.delete(watch.channel);
  }

  #dropInput(conn: SessionConnection, what: string): Promise<void> {
    this.#log(`session ${conn.id}: dropped ${what}`);
    return Promise.resolve();
  }

  #onCore(event: CoreClientEvent): void {
    if (event.type === "down") return;
    for (const socket of this.#sockets.values()) {
      for (const watch of socket.watches.values()) {
        if (event.type === "reset") this.#onReset(watch);
        else if (matches(watch, event.terminal)) this.#onEvent(watch, event.kind, event.data);
      }
    }
  }

  /** A fresh snapshot: re-attach what a dropped connection ended; recheck sizes that may have moved unseen. */
  #onReset(watch: Watch): void {
    if (watch.closed) return;
    const facts = this.#core.terminals.get(watch.address);
    if (watch.typist && facts && !sameSize(watch.typist.stream, facts)) this.#stopTyping(watch);
    if (watch.stream && !watch.stream.resizeNotifications && facts && watch.size && !sameSize(watch.size, facts)) {
      this.#detach(watch);
    }
    void this.#attach(watch);
  }

  #onEvent(watch: Watch, kind: string, data: Record<string, unknown>): void {
    if (watch.closed) return;
    switch (kind) {
      case "size": {
        const size = sizeOf(data);
        if (watch.typist && !sameSize(watch.typist.stream, size)) this.#stopTyping(watch);
        // With RESIZE notifications the stream itself announces the new size before repainting.
        if (watch.stream && !watch.stream.resizeNotifications && watch.size && !sameSize(watch.size, size)) {
          this.#detach(watch);
          void this.#attach(watch);
        }
        return;
      }
      case "created":
      case "restarted":
        void this.#attach(watch);
        return;
    }
  }
}

function ack(conn: SessionConnection, id: number, error?: AckError, message?: string): void {
  conn.send(error ? { t: "ack", id, ok: false, error, ...(message ? { message } : {}) } : { t: "ack", id, ok: true });
}

function attachFailure(terminal: string, error: Error): string {
  const kind = error instanceof CoreError ? error.kind : "error";
  switch (kind) {
    case "not_found":
      return `no terminal ${terminal}`;
    case "finished":
      return `terminal ${terminal} has finished`;
    case "unavailable":
    case "disconnected":
    case "timeout":
    case "closed":
      return "herdr-core is not reachable";
    default:
      return `cannot attach to ${terminal} (${kind})`;
  }
}

function matches(watch: Watch, terminal: string | null): boolean {
  return terminal !== null && (terminal === watch.address || terminal === watch.terminal);
}

function sizeOf(data: Record<string, unknown>): Size {
  return { cols: Number(data.cols), rows: Number(data.rows) };
}

function sameSize(a: Size, b: Size): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
