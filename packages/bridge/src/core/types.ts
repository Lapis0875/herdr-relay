/**
 * herdr-core shapes the bridge reads, from `hc schema` (herdr-core 0.1.19, protocol generation 1, OpenRPC 1.3.2).
 * Records are open: the core only adds fields within a generation, so unknown keys are kept.
 */

/** Protocol generation this client speaks (`hello {generation}`). */
export const CORE_GENERATION = 1;
/** Oldest herdr-core this client was verified against on this Mac (`hc --version` → 0.1.19). */
export const CORE_MINIMUM_VERSION = "0.1.19";
/** The `herdr-app` document Herdr keeps in the core (spaces, tabs, panes). */
export const HERDR_APP_DOC = "herdr-app";

/**
 * Every method the bridge may call — the whole allowlist. Calls are read-only except `terminal.attach`, whose
 * `type` mode writes only bytes a device user typed. `doc.set`, `terminal.run`, `terminal.send`, `terminal.kill`
 * and every other method are unreachable through this client (DESIGN-v2 §5.1).
 */
export const CORE_METHODS = [
  "hello",
  "rpc.discover",
  "doc.get",
  "terminal.list",
  "terminal.get",
  "events.subscribe",
  "terminal.attach",
] as const;
export type CoreMethod = (typeof CORE_METHODS)[number];

/** `CoreInfo`: a core's identity. */
export interface CoreIdentity {
  /** Permanent random id, reset only when state is wiped. */
  id: string;
  /** Display name, the hostname by default. */
  name: string;
}

/** `HelloResult`. */
export interface CoreHello {
  generation: number;
  version: string;
  core: CoreIdentity;
  framed: boolean;
  methods: string[];
  features: string[];
  [key: string]: unknown;
}

/** `rpc.discover`: the whole API as an OpenRPC document. */
export interface CoreSchema {
  openrpc: string;
  info: { version: string; title?: string; [key: string]: unknown };
  methods: { name: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

/** One OSC 7501 status record (`Status`); words are the program's own. */
export interface CoreStatus {
  /** idle, working, done, blocked or error. */
  state: string;
  kind?: string | null;
  progress?: number | null;
  app?: string;
  title?: string;
  msg?: string;
  [key: string]: unknown;
}

/** `Terminal`: one terminal's facts, live or finished. */
export interface CoreTerminal {
  /** `t7` on this core; `machine/t7` on a connected machine. */
  address: string;
  labels: Record<string, string>;
  argv: string[];
  cwd: string;
  /** "live" or "finished". */
  state: string;
  created_ms: number;
  /** "exact", or "inexact" after a core crash. */
  screen: string;
  cols: number;
  rows: number;
  name?: string | null;
  parent?: string | null;
  pid?: number | null;
  status?: CoreStatus | null;
  status_ms?: number | null;
  turn?: number;
  title?: string;
  reason?: string | null;
  exit_code?: number | null;
  signal?: number | null;
  finished_ms?: number | null;
  [key: string]: unknown;
}

/** `ListResult`. */
export interface CoreTerminalList {
  terminals: CoreTerminal[];
  hidden_finished: number;
  /** Added machines; absent when there are none (observed on 0.1.19, although `hc schema` marks it required). */
  machines?: Record<string, unknown>[];
  [key: string]: unknown;
}

/** `DocGetResult`: an opaque JSON document and its version (0 when never written). */
export interface CoreDoc<T = unknown> {
  value: T;
  version: number;
}

/** `SubscribeResult` (framed): the matching terminals, the sequence events continue after, and their channel. */
export interface CoreSnapshot {
  seq: number;
  terminals: CoreTerminal[];
  channel: number;
}

/** `AttachResult`. */
export interface CoreAttachResult {
  channel: number;
  terminal: CoreTerminal;
  /** True only when the whole path sends RESIZE before replacement paints. */
  resize_notifications: boolean;
  /** The whole path accepts AUTOMATIC_INPUT (kind 6). */
  automatic_input: boolean;
  [key: string]: unknown;
}

/** Fact changes `events.subscribe` reports (`hc schema`, `events.subscribe` description). */
export const CORE_EVENT_KINDS = [
  "created",
  "lost",
  "restarted",
  "keep",
  "finished",
  "removed",
  "status",
  "turn",
  "title",
  "labels",
  "size",
  "doc",
] as const;
export type CoreEventKind = (typeof CORE_EVENT_KINDS)[number];

/** A line on the event stream. */
export interface CoreNotification {
  jsonrpc: "2.0";
  /** `event` per fact change, `heartbeat` every 15 s, `missed` + a fresh snapshot after falling behind. */
  method: "event" | "heartbeat" | "missed" | (string & Record<never, never>);
  params: {
    seq?: number;
    type?: string;
    terminal?: string;
    machine?: string;
    data?: Record<string, unknown>;
    terminals?: CoreTerminal[];
    [key: string]: unknown;
  };
}
