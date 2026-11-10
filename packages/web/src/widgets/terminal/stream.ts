/**
 * Terminal streams over the device socket (PROTOCOL.md §5.2; the bridge side is T11's `terminal/relay.ts`).
 *
 * A view follows a terminal through a {@link TerminalSource}. The bridge source sends `term.open {mode:"observe"}`;
 * the bridge answers `term.size {terminal, channel, cols, rows}` (the Mac's geometry, D4) followed by a full paint as
 * binary frames `[u32 channel][bytes]` on that channel, and announces every later size change the same way. Views of
 * one terminal share one stream (one `term.open` per socket and terminal); a view that joins a running stream asks
 * for a fresh paint by reopening it. Each new socket (`hello`, resumed or not) starts the channels over, so every
 * followed terminal is opened again; while there is no live socket the views keep their last screen.
 *
 * Typing (an `act` device, D3) goes through the same socket: the first keystroke upgrades the stream with
 * `term.open {mode:"type"}` and, once acked, the bytes go out as binary frames on the stream's channel. Bytes typed
 * while the upgrade is in flight wait for it; nothing is replayed after a reconnect. The remote never resizes.
 */

import { encodeTerminalFrame, type TermSize } from "@herdr-relay/protocol";
import { bridge } from "../../app/client.ts";
import { type AppState, getState, subscribe } from "../../app/store.ts";

/** What a view is told about its terminal. */
export type StreamStatus =
  /** No live socket: the last screen stays. */
  | { kind: "offline" }
  /** `term.open` sent; the size and paint have not arrived yet. */
  | { kind: "opening" }
  /** Painting; `typing`: keystrokes go to the Mac. */
  | { kind: "live"; typing: boolean }
  /** The bridge refused the terminal (gone, too many open, …). */
  | { kind: "refused"; message: string };

export interface TerminalSink {
  /** The Mac's geometry; a full paint at that size follows (start over). */
  size(cols: number, rows: number): void;
  data(bytes: Uint8Array): void;
  status(status: StreamStatus): void;
}

/** Where a terminal view's bytes come from: the bridge, or a canned recording (dev stories). */
export interface TerminalSource {
  /** Starts following; returns the function that stops. The sink hears the current status at once. */
  attach(sink: TerminalSink): () => void;
  /** Sends typed bytes; resolves `false` when they could not be delivered. Absent: the source is read-only. */
  type?(bytes: Uint8Array): Promise<boolean>;
  /** Asks again after a refusal. */
  retry?(): void;
}

/** One binary frame of typed input stays well under the bridge's 256 KiB limit (`MAX_INPUT_BYTES`). */
const TYPE_CHUNK = 64 * 1024;

interface Entry {
  readonly terminal: string;
  readonly sinks: Set<TerminalSink>;
  mode: "observe" | "type";
  /** The `term.size` the sinks were last told (its `channel` routes binary frames). */
  size: TermSize | null;
  /** A `term.size` already in the store when this stream was (re)opened: an earlier stream's, not this one's. */
  ignore: TermSize | null;
  upgrading: Promise<boolean> | null;
  status: StreamStatus;
}

class BridgeTerminals {
  readonly #entries = new Map<string, Entry>();
  readonly #channels = new Map<number, Entry>();
  #conn: AppState["conn"] | null = null;
  #terms: AppState["terms"] | null = null;
  #started = false;

  /** Follows `terminal` into `sink`; returns the function that stops. */
  open(terminal: string, sink: TerminalSink): () => void {
    this.#start();
    let entry = this.#entries.get(terminal);
    if (!entry) {
      entry = {
        terminal,
        sinks: new Set(),
        mode: "observe",
        size: null,
        ignore: null,
        upgrading: null,
        status: OFFLINE,
      };
      this.#entries.set(terminal, entry);
      entry.sinks.add(sink);
      void this.#open(entry);
    } else {
      entry.sinks.add(sink);
      sink.status(entry.status);
      // The running stream already painted: start it over so the new view gets a whole screen too.
      if (entry.size) void this.#reopen(entry);
    }
    return () => this.#leave(entry, sink);
  }

  /** Types into `terminal`; upgrades its stream to `type` first. */
  async type(terminal: string, bytes: Uint8Array): Promise<boolean> {
    const entry = this.#entries.get(terminal);
    if (!entry || bytes.length === 0 || getState().hello?.scope !== "act") return false;
    if (entry.mode !== "type") {
      entry.upgrading ??= this.#upgrade(entry).finally(() => (entry.upgrading = null));
      if (!(await entry.upgrading)) return false;
    }
    const channel = entry.size?.channel;
    if (channel === undefined) return false;
    for (let at = 0; at < bytes.length; at += TYPE_CHUNK) {
      if (!bridge.sendBinary(encodeTerminalFrame(channel, bytes.subarray(at, at + TYPE_CHUNK)))) return false;
    }
    return true;
  }

  retry(terminal: string): void {
    const entry = this.#entries.get(terminal);
    if (entry && entry.status.kind === "refused") void this.#open(entry);
  }

  #start(): void {
    if (this.#started) return;
    this.#started = true;
    bridge.onBinary((channel, bytes) => {
      const entry = this.#channels.get(channel);
      if (entry) { for (const sink of entry.sinks) sink.data(bytes); }
    });
    this.#conn = getState().conn;
    this.#terms = getState().terms;
    subscribe(() => this.#sync());
  }

  /** Follows the store: a new socket reopens every stream; a `term.size` (re)starts one. Runs inside `setState`. */
  #sync(): void {
    const s = getState();
    if (s.conn !== this.#conn) {
      const wasLive = this.#conn?.kind === "live";
      this.#conn = s.conn;
      if (s.conn.kind === "live") {
        // A bridge `hello`: the channels of the previous socket are gone.
        this.#channels.clear();
        for (const entry of this.#entries.values()) {
          entry.mode = "observe";
          entry.size = null;
          queueMicrotask(() => void this.#open(entry));
        }
      } else if (wasLive) {
        for (const entry of this.#entries.values()) this.#setStatus(entry, OFFLINE);
      }
    }
    if (s.terms !== this.#terms) {
      this.#terms = s.terms;
      for (const entry of this.#entries.values()) {
        const size = s.terms[entry.terminal];
        if (size && size !== entry.size && size !== entry.ignore) this.#resized(entry, size);
      }
    }
  }

  #resized(entry: Entry, size: TermSize): void {
    if (entry.size && entry.size.channel !== size.channel) this.#channels.delete(entry.size.channel);
    entry.size = size;
    this.#channels.set(size.channel, entry);
    for (const sink of entry.sinks) sink.size(size.cols, size.rows);
    this.#setStatus(entry, { kind: "live", typing: entry.mode === "type" });
  }

  async #open(entry: Entry): Promise<void> {
    const conn = getState().conn;
    if (conn.kind !== "live") return this.#setStatus(entry, OFFLINE);
    entry.ignore = getState().terms[entry.terminal] ?? null;
    entry.size = null;
    this.#setStatus(entry, { kind: "opening" });
    const ack = await bridge.request({ t: "term.open", terminal: entry.terminal, mode: entry.mode }, null);
    if (this.#entries.get(entry.terminal) !== entry || getState().conn !== conn) return;
    if (!ack.ok) {
      if (ack.message === "offline") return this.#setStatus(entry, OFFLINE);
      this.#setStatus(entry, { kind: "refused", message: ack.message ?? ack.error ?? "refused" });
    }
  }

  /** A fresh paint for every view: close and open again (a new channel and `term.size` follow). */
  async #reopen(entry: Entry): Promise<void> {
    if (getState().conn.kind !== "live") return;
    if (entry.size) this.#channels.delete(entry.size.channel);
    entry.size = null;
    entry.mode = "observe";
    await bridge.request({ t: "term.close", terminal: entry.terminal }, null);
    if (this.#entries.get(entry.terminal) === entry) await this.#open(entry);
  }

  async #upgrade(entry: Entry): Promise<boolean> {
    const conn = getState().conn;
    if (conn.kind !== "live" || !entry.size) return false;
    const ack = await bridge.request({ t: "term.open", terminal: entry.terminal, mode: "type" }, "typing");
    if (this.#entries.get(entry.terminal) !== entry || getState().conn !== conn) return false;
    if (!ack.ok) return false;
    entry.mode = "type";
    if (entry.status.kind === "live") this.#setStatus(entry, { kind: "live", typing: true });
    return true;
  }

  #leave(entry: Entry, sink: TerminalSink): void {
    entry.sinks.delete(sink);
    if (entry.sinks.size > 0 || this.#entries.get(entry.terminal) !== entry) return;
    this.#entries.delete(entry.terminal);
    if (entry.size) this.#channels.delete(entry.size.channel);
    if (getState().conn.kind === "live") void bridge.request({ t: "term.close", terminal: entry.terminal }, null);
  }

  #setStatus(entry: Entry, status: StreamStatus): void {
    entry.status = status;
    for (const sink of entry.sinks) sink.status(status);
  }
}

const OFFLINE: StreamStatus = { kind: "offline" };

const terminals = new BridgeTerminals();

/** The bridge's stream of one terminal (the app's terminal screens). */
export function bridgeTerminalSource(terminal: string): TerminalSource {
  return {
    attach: (sink) => terminals.open(terminal, sink),
    type: (bytes) => terminals.type(terminal, bytes),
    retry: () => terminals.retry(terminal),
  };
}
