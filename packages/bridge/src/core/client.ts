/**
 * The bridge's one link to herdr-core (DESIGN-v2 §1.1): an `hc connect` child speaking JSON-RPC 2.0 with
 * generation-1 frames. It keeps itself connected — when the child exits or the stream breaks it re-spawns,
 * re-negotiates (`hello`, `rpc.discover`), re-subscribes and announces `reset` (Shepherdr `hub.ts`/`live.ts` pattern,
 * SECURITY.md "Offline/reconnect"). It mirrors the terminal list from `events.subscribe` so consumers can read it
 * synchronously.
 *
 * Listener contract:
 * - `reset` — a fresh snapshot replaced the mirror (`connected` first time, `reconnected` after a drop, `missed` when
 *   the core says this subscriber fell behind). Drop everything derived from core state and rebuild; terminal
 *   streams of a dropped connection have already ended — re-attach (observe) if still wanted; typed input is never
 *   replayed.
 * - `down` — the connection dropped; calls in flight were rejected; reconnection is under way. The mirror keeps the
 *   last known terminals until the next `reset`.
 * - `event` — one fact change, already applied to the mirror.
 */

import { checkDoc, checkTerminal, checkTerminalList, isRecord } from "./checks.ts";
import {
  type AttachRequest,
  CoreConnection,
  DEFAULT_CALL_TIMEOUT_MS,
  negotiate,
  type TerminalStream,
} from "./connection.ts";
import { CoreError, messageOf } from "./errors.ts";
import { type CoreTransport, type CoreTransportFactory, spawnHcConnect } from "./transport.ts";
import type {
  CoreDoc,
  CoreHello,
  CoreMethod,
  CoreNotification,
  CoreSchema,
  CoreSnapshot,
  CoreTerminal,
  CoreTerminalList,
} from "./types.ts";

/** Delay before reconnect attempt n (the last entry repeats): immediately, then 0.5 s, 1 s, 2 s, every 5 s. */
export const DEFAULT_BACKOFF_MS: readonly number[] = [0, 500, 1000, 2000, 5000];

export interface CoreClientOptions {
  /** Opens one transport per connection attempt. Default: spawn `hc connect`. */
  transport?: CoreTransportFactory;
  /** Reconnect delays, ms; see {@link DEFAULT_BACKOFF_MS}. */
  backoffMs?: readonly number[];
  /** Default per-call deadline, ms, including waiting for a connection. */
  timeoutMs?: number;
  /** Diagnostics sink. Default: `console.error` with a `herdr-core:` prefix. */
  log?: (message: string) => void;
}

export type CoreClientState = "idle" | "connecting" | "up" | "closed";

/** The negotiated connection currently in use. */
export interface CoreSession {
  hello: CoreHello;
  /** `rpc.discover` of this connection (OpenRPC). */
  schema: CoreSchema;
  /** The `hc connect` child's pid, for a process transport. */
  pid: number | null;
  /** `Date.now()` when it came up. */
  since: number;
}

export type CoreResetReason = "connected" | "reconnected" | "missed";

export type CoreClientEvent =
  | { type: "reset"; reason: CoreResetReason; seq: number; terminals: readonly CoreTerminal[] }
  | { type: "down"; error: CoreError }
  | {
    type: "event";
    /** `created`, `lost`, `restarted`, `keep`, `finished`, `removed`, `status`, `turn`, `title`, `labels`, `size`, `doc`, … */
    kind: string;
    seq: number | null;
    /** Address (`t7`, or `machine/t7` for a connected machine); null for document events. */
    terminal: string | null;
    machine: string | null;
    data: Record<string, unknown>;
  };

export type CoreClientListener = (event: CoreClientEvent) => void;

/** {@link AttachRequest} minus what the client fills in: the size is the terminal's own (see `attach`). */
export type AttachOptions = Omit<AttachRequest, "terminal" | "cols" | "rows" | "timeout"> & { timeoutMs?: number };

interface Waiter {
  resolve(session: CoreSession): void;
  reject(error: CoreError): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Opened {
  connection: CoreConnection;
  session: CoreSession;
  snapshot: CoreSnapshot;
  /** Starts applying notifications, replaying those that arrived before adoption. */
  adopt(): void;
}

export class CoreClient {
  readonly #factory: CoreTransportFactory;
  readonly #backoff: readonly number[];
  readonly #timeout: number;
  readonly #log: (message: string) => void;
  readonly #listeners = new Set<CoreClientListener>();
  readonly #waiters = new Set<Waiter>();
  #state: CoreClientState = "idle";
  #connection: CoreConnection | null = null;
  /** A connection still negotiating; closed by `close()` so it cannot outlive the client. */
  #opening: CoreConnection | null = null;
  #session: CoreSession | null = null;
  #terminals = new Map<string, CoreTerminal>();
  #seq = 0;
  #lastError: CoreError | null = null;
  #loop: Promise<void> | null = null;
  #wake: (() => void) | null = null;

  constructor(options: CoreClientOptions = {}) {
    this.#factory = options.transport ?? (() => spawnHcConnect());
    this.#backoff = options.backoffMs?.length ? options.backoffMs : DEFAULT_BACKOFF_MS;
    this.#timeout = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.#log = options.log ?? ((message) => console.error(`herdr-core: ${message}`));
  }

  get state(): CoreClientState {
    return this.#state;
  }

  /** The connection in use, or null while connecting. */
  get session(): CoreSession | null {
    return this.#session;
  }

  /** Why the last attempt or connection failed; null once connected. */
  get lastError(): CoreError | null {
    return this.#lastError;
  }

  /** Sequence number of the last applied event (or snapshot). */
  get seq(): number {
    return this.#seq;
  }

  /** Terminals by address, from the latest snapshot plus the events after it. */
  get terminals(): ReadonlyMap<string, CoreTerminal> {
    return this.#terminals;
  }

  /** Subscribes to `reset` / `down` / `event`; returns the unsubscribe function. */
  on(listener: CoreClientListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Starts connecting (idempotent). Calls start it implicitly. */
  start(): void {
    if (this.#state === "closed" || this.#loop) return;
    this.#state = "connecting";
    this.#loop = this.#run();
  }

  /** Resolves with the session once connected; rejects `unavailable` after `timeoutMs`, `closed` on close. */
  ready(timeoutMs: number = this.#timeout): Promise<CoreSession> {
    if (this.#state === "closed") return Promise.reject(new CoreError("closed", "the core client is closed"));
    this.start();
    if (this.#state === "up" && this.#session) return Promise.resolve(this.#session);
    const { promise, resolve, reject } = Promise.withResolvers<CoreSession>();
    const waiter: Waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        this.#waiters.delete(waiter);
        const why = this.#lastError ? `: ${this.#lastError.message}` : "";
        reject(new CoreError("unavailable", `herdr-core is not reachable within ${timeoutMs} ms${why}`));
      }, timeoutMs),
    };
    this.#waiters.add(waiter);
    return promise;
  }

  /** `rpc.discover` of the current connection (fetched and checked while negotiating). */
  async discover(timeoutMs?: number): Promise<CoreSchema> {
    return (await this.ready(timeoutMs)).schema;
  }

  /** `doc.get {name}` on this Mac's core (other machines are out of scope). */
  async docGet<T = unknown>(name: string, timeoutMs?: number): Promise<CoreDoc<T>> {
    return checkDoc<T>(await this.#call("doc.get", { name }, timeoutMs));
  }

  /** `terminal.list`: live terminals (finished too with `all`), optionally filtered by labels. */
  async terminalList(
    options: { all?: boolean; labels?: Record<string, string> } = {},
    timeoutMs?: number,
  ): Promise<CoreTerminalList> {
    const params: Record<string, unknown> = {};
    if (options.all) params.all = true;
    if (options.labels) params.labels = options.labels;
    return checkTerminalList(await this.#call("terminal.list", params, timeoutMs));
  }

  /** `terminal.get {terminal}`: one terminal's facts, live or finished. */
  async terminalGet(terminal: string, timeoutMs?: number): Promise<CoreTerminal> {
    return checkTerminal(await this.#call("terminal.get", { terminal }, timeoutMs));
  }

  /**
   * `terminal.attach` at the terminal's own size, read with `terminal.get` on the same connection just before: a
   * `type` attach at any other size would resize the Mac's terminal for everyone (D4), and an observe attach never
   * resizes but must still name a size. No method of the returned stream can resize.
   */
  async attach(terminal: string, options: AttachOptions): Promise<TerminalStream> {
    const { timeoutMs, ...request } = options;
    if (request.mode !== "observe" && request.mode !== "type") {
      throw new CoreError("refused", `unknown attach mode ${String(request.mode)}`);
    }
    const deadline = Date.now() + (timeoutMs ?? this.#timeout);
    const remaining = () => Math.max(1, deadline - Date.now());
    await this.ready(remaining());
    const connection = this.#connection;
    if (!connection) throw this.#lastError ?? new CoreError("disconnected", "the core connection dropped");
    const facts = checkTerminal(await connection.call("terminal.get", { terminal }, { timeout: remaining() }));
    return connection.attach({ ...request, terminal, cols: facts.cols, rows: facts.rows, timeout: remaining() });
  }

  /** Stops reconnecting, ends the connection, kills the child and waits until it is gone. */
  async close(): Promise<void> {
    if (this.#isClosed()) {
      await this.#loop;
      return;
    }
    this.#state = "closed";
    this.#wake?.();
    const closed = new CoreError("closed", "the core client is closed");
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(closed);
    }
    this.#waiters.clear();
    await Promise.all([this.#opening?.close(), this.#connection?.close()]);
    await this.#loop;
  }

  async #call(method: CoreMethod, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const deadline = Date.now() + (timeoutMs ?? this.#timeout);
    await this.ready(Math.max(1, deadline - Date.now()));
    const connection = this.#connection;
    if (!connection) throw this.#lastError ?? new CoreError("disconnected", "the core connection dropped");
    return connection.call(method, params, { timeout: Math.max(1, deadline - Date.now()) });
  }

  async #run(): Promise<void> {
    let attempt = 0;
    let everUp = false;
    while (!this.#isClosed()) {
      const delay = this.#backoff[Math.min(attempt, this.#backoff.length - 1)];
      if (delay > 0) await this.#sleep(delay);
      if (this.#isClosed()) break;
      let opened: Opened;
      try {
        opened = await this.#open();
      } catch (error) {
        const failure = error instanceof CoreError
          ? error
          : new CoreError("unavailable", messageOf(error), { cause: error });
        if (this.#isClosed()) break;
        this.#lastError = failure;
        attempt++;
        this.#log(`connecting failed (attempt ${attempt}): ${failure.message}`);
        continue;
      }
      if (this.#isClosed()) {
        await opened.connection.close();
        break;
      }
      attempt = 0;
      this.#adopt(opened, everUp ? "reconnected" : "connected");
      everUp = true;
      const error = await opened.connection.ended;
      this.#connection = null;
      this.#session = null;
      if (this.#isClosed()) break;
      this.#state = "connecting";
      this.#lastError = error;
      this.#log(`connection lost: ${error.message}`);
      void opened.connection.transport.closed.then((reason) => this.#log(reason));
      this.#emit({ type: "down", error });
    }
  }

  async #open(): Promise<Opened> {
    const transport: CoreTransport = await this.#factory();
    const connection = new CoreConnection(transport, { log: this.#log });
    this.#opening = connection;
    try {
      const { hello, schema } = await negotiate(connection, this.#timeout);
      const early: CoreNotification[] = [];
      let adopted = false;
      const snapshot = await connection.subscribe(
        (notification) => adopted ? this.#notification(notification) : early.push(notification),
        this.#timeout,
      );
      return {
        connection,
        session: { hello, schema, pid: transport.pid ?? null, since: Date.now() },
        snapshot,
        adopt: () => {
          adopted = true;
          try {
            for (const notification of early.splice(0)) this.#notification(notification);
          } catch (error) {
            // Same outcome as a bad line arriving live: drop the connection and reconnect.
            void connection.abort(
              error instanceof CoreError ? error : new CoreError("protocol", messageOf(error), { cause: error }),
            );
          }
        },
      };
    } catch (error) {
      await connection.close();
      throw error;
    } finally {
      this.#opening = null;
    }
  }

  #adopt(opened: Opened, reason: CoreResetReason): void {
    this.#connection = opened.connection;
    this.#session = opened.session;
    this.#state = "up";
    this.#lastError = null;
    this.#replace(opened.snapshot.seq, opened.snapshot.terminals, reason);
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(opened.session);
    }
    this.#waiters.clear();
    opened.adopt();
  }

  #replace(seq: number, terminals: CoreTerminal[], reason: CoreResetReason): void {
    this.#terminals = new Map(terminals.map((terminal) => [terminal.address, terminal]));
    this.#seq = seq;
    this.#emit({ type: "reset", reason, seq, terminals });
  }

  #notification(notification: CoreNotification): void {
    const params = notification.params;
    if (notification.method === "missed") {
      if (Array.isArray(params.terminals) && typeof params.seq === "number") {
        this.#replace(params.seq, params.terminals.map((terminal) => checkTerminal(terminal, "missed")), "missed");
      } else this.#log("ignored a `missed` notification without a snapshot");
      return;
    }
    // `heartbeat` (every 15 s) and methods newer than this client carry nothing to apply.
    if (notification.method !== "event" || typeof params.type !== "string") return;
    const seq = typeof params.seq === "number" ? params.seq : null;
    if (seq !== null) {
      if (seq <= this.#seq) return; // already covered by the snapshot (`hc schema`, SubscribeResult.seq)
      this.#seq = seq;
    }
    const machine = typeof params.machine === "string" ? params.machine : null;
    let terminal = typeof params.terminal === "string" ? params.terminal : null;
    if (terminal && machine && !terminal.includes("/")) terminal = `${machine}/${terminal}`;
    const data = isRecord(params.data) ? params.data : {};
    if (terminal) this.#apply(params.type, terminal, data);
    this.#emit({ type: "event", kind: params.type, seq, terminal, machine, data });
  }

  /** Folds one fact change into the mirror (Shepherdr `hub.ts` reduction). */
  #apply(kind: string, address: string, data: Record<string, unknown>): void {
    const old = this.#terminals.get(address);
    switch (kind) {
      case "created":
      case "restarted":
        if (typeof data.address === "string") this.#terminals.set(address, data as CoreTerminal);
        else if (old) this.#terminals.set(address, { ...old, ...data });
        return;
      case "removed":
        this.#terminals.delete(address);
        return;
      case "labels":
        if (isRecord(data.record) && typeof data.record.address === "string") {
          this.#terminals.set(address, data.record as CoreTerminal);
        } else if (old && isRecord(data.labels)) {
          this.#terminals.set(address, { ...old, labels: data.labels as Record<string, string> });
        }
        return;
      case "finished":
        if (old) this.#terminals.set(address, { ...old, ...data, state: "finished" });
        return;
      case "lost":
        if (old) this.#terminals.set(address, { ...old, ...data, pid: null });
        return;
      case "turn":
        if (old && typeof data.turn === "number") this.#terminals.set(address, { ...old, turn: data.turn });
        return;
      case "status":
      case "size":
      case "title":
      case "keep":
        if (old) this.#terminals.set(address, { ...old, ...data });
        return;
    }
  }

  #emit(event: CoreClientEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#log(`a ${event.type} listener failed: ${messageOf(error)}`);
      }
    }
  }

  #sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      this.#wake = null;
      resolve();
    }, ms);
    this.#wake = () => {
      clearTimeout(timer);
      this.#wake = null;
      resolve();
    };
    return promise;
  }

  /** A call, not a field read, so TypeScript does not keep a narrowing of `#state` across awaits. */
  #isClosed(): boolean {
    return this.#state === "closed";
  }
}
