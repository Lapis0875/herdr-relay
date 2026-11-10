/**
 * Bridge ⇄ mod host control channel (DESIGN-v2 §1.5): token-authenticated NDJSON over TCP `127.0.0.1:<ctlPort>`, one
 * JSON object per `\n`-terminated UTF-8 line, discriminated on `t`. The mod host is plain JS and does not import this
 * module; its tests validate against `schema/control-*.schema.json` or these validators.
 *
 * Trust rule: the bridge attributes every message to the folder of the connection it arrived on, never to the
 * `copy`/`origin` a message claims; a `copy` not prefixed `<folder>:` is logged `forged-*-ignored` and dropped
 * (`copyBelongsTo`). `origin.session` is an opaque token the bridge minted for one delivered `event`/`command`; it
 * names a device session only for that folder's current host, for 30 s. Any other token (unknown, expired, another
 * folder's, an earlier host's) counts as `read` from no device. Raw session ids never reach a host.
 */

import {
  AgentInfoSchema,
  CommandInfoSchema,
  FocusedSchema,
  KeyBindingInfoSchema,
  LayoutNodeSchema,
  MachineInfoSchema,
  PaneInfoSchema,
  SharedSchema,
  SpaceInfoSchema,
  TerminalInfoSchema,
  ThemeInfoSchema,
  UpdatesInfoSchema,
  WindowInfoSchema,
} from "./herdr.ts";
import {
  array,
  boolean,
  decode,
  define,
  enumOf,
  integer,
  jsonObjectRef,
  jsonValueRef,
  literal,
  nullable,
  number,
  object,
  record,
  type Same,
  type Static,
  string,
  tagged,
  validate,
  type Validation,
} from "./schema.ts";
import { RecordedTreeSchema } from "./tree.ts";

/** Longest control line, in bytes including `\n`; a host sending a longer one is killed. */
export const CONTROL_MAX_LINE_BYTES = 4 * 1024 * 1024;
/** A connection that has not sent a valid `hello` within this many ms is dropped. */
export const CONTROL_HELLO_TIMEOUT_MS = 1000;
/** The bridge pings each host this often; three missed `pong`s → SIGKILL and restart. */
export const CONTROL_PING_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------------------------------------------------
// Copy ids.

/** A mod folder name (a directory under `<appHome>/mods`). */
export const FOLDER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
/** `<folder>:<blockId>`, `<folder>:overlay:<id>` or `<folder>:pane:<id>`. */
export const COPY_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*:\\S+$";

export type CopyKind = "block" | "overlay" | "pane";
export interface CopyRef {
  folder: string;
  kind: CopyKind;
  id: string;
}

const COPY_ID = new RegExp(COPY_ID_PATTERN, "u");

/** Splits a copy id; `null` when it is not `<folder>:…`. */
export function parseCopyId(copy: string): CopyRef | null {
  if (!COPY_ID.test(copy)) return null;
  const sep = copy.indexOf(":");
  const folder = copy.slice(0, sep);
  const rest = copy.slice(sep + 1);
  for (const kind of ["overlay", "pane"] as const) {
    if (rest.startsWith(`${kind}:`) && rest.length > kind.length + 1) {
      return { folder, kind, id: rest.slice(kind.length + 1) };
    }
  }
  return { folder, kind: "block", id: rest };
}

export function formatCopyId(ref: CopyRef): string {
  return ref.kind === "block" ? `${ref.folder}:${ref.id}` : `${ref.folder}:${ref.kind}:${ref.id}`;
}

/** The trust rule: does `copy` (as claimed by a message) belong to the connection's `folder`? */
export function copyBelongsTo(copy: string, folder: string): boolean {
  return parseCopyId(copy)?.folder === folder;
}

const copyId = () => string({ pattern: COPY_ID_PATTERN });
const folderName = () => string({ pattern: FOLDER_PATTERN });
const counter = () => integer({ minimum: 0 });
const ms = () => number({ minimum: 0, description: "milliseconds" });

// ---------------------------------------------------------------------------------------------------------------------
// Shared shapes.

/** `placement()` of a floating copy: where it sits now (null for copies that do not float). */
export const PlacementSchema = define("Placement", () =>
  object({
    edge: enumOf(["top", "right", "bottom", "left"]),
    align: enumOf(["start", "center", "end"]),
    vertical: boolean(),
    hovered: boolean(),
    dragging: boolean(),
  }));
export type Placement = Static<typeof PlacementSchema>;

/**
 * Everything a mod reads synchronously from `herdr`, for one folder: pushed in `boot` and `state` (debounced 16 ms,
 * full snapshot). One host serves every device, so it is the Mac's state with the lead session's view on top (the
 * device that acted last; without a session, the Mac's own): that session's `layout` and `focused`, and its
 * selection, focus and zoom flags in `spaces`, `panes` and `agents` (the `active` space and tabs, the `focused` pane
 * and agent, `zoomed` tabs and panes; nothing zoomed on a phone). `fonts` are the Mac's font families
 * (`herdr.fonts()`), not the client's.
 */
export const HostStateSchema = define("HostState", () =>
  object({
    folder: folderName(),
    home: string({ minLength: 1 }),
    appHome: string({ minLength: 1 }),
    spaces: array(SpaceInfoSchema),
    agents: array(AgentInfoSchema),
    panes: array(PaneInfoSchema),
    terminals: array(TerminalInfoSchema),
    focused: nullable(FocusedSchema),
    layout: LayoutNodeSchema,
    layouts: array(string()),
    commands: array(CommandInfoSchema),
    window: WindowInfoSchema,
    theme: record(string()),
    themes: array(ThemeInfoSchema),
    fonts: array(string()),
    updates: UpdatesInfoSchema,
    settings: jsonObjectRef,
    keys: array(KeyBindingInfoSchema),
    machines: array(MachineInfoSchema),
    shared: SharedSchema,
  }));
export type HostState = Static<typeof HostStateSchema>;

/**
 * Where a host call came from: `session` is the opaque origin token of the `event`/`command` whose handling led to it
 * (copy-scoped via AsyncLocalStorage in the host), never a raw device session id. The host passes it back unchanged.
 */
export const OriginSchema = define("Origin", () => object({ session: string({ minLength: 1 }) }));
export type Origin = Static<typeof OriginSchema>;

/** `herdr` functions a host forwards fire-and-forget. */
export const EMIT_METHODS = [
  "run",
  "notify",
  "openOverlay",
  "closeOverlay",
  "setShared",
  "setAgentOrder",
  "playSound",
  "write_to_clipboard",
  "net.close",
  "focus",
] as const;
export type EmitMethod = (typeof EMIT_METHODS)[number];

/** `herdr` functions a host awaits an `rpc-result` for. */
export const RPC_METHODS = [
  "readTextFile",
  "writeTextFile",
  "exec",
  "hc",
  "knownAgents",
  "watchFolder",
  "net.connect",
  "net.write",
  "net.read",
  "storage.set",
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

// ---------------------------------------------------------------------------------------------------------------------
// Bridge → host.

export const BootSchema = define("Boot", () =>
  object({
    t: literal("boot"),
    state: HostStateSchema,
    harden: literal(true),
    mainUrl: string({ pattern: "^file:///.+/mods/[^/]+/main\\.js$" }),
  }));
/**
 * One copy's `localStorage`: key → value, both strings (Web Storage semantics). The host sends the whole map with
 * `storage.set [map]` on every change; the bridge persists it and returns it in `create.storage`.
 */
export const StorageMapSchema = define("StorageMap", () => record(string()));
export type StorageMap = Static<typeof StorageMapSchema>;

/** A new copy. `storage` restores its persisted `localStorage` before the mod's constructor runs (absent = empty). */
export const CreateSchema = define(
  "Create",
  () =>
    object(
      { t: literal("create"), copy: copyId(), props: jsonObjectRef, placement: nullable(PlacementSchema) },
      { storage: StorageMapSchema },
    ),
);
export const StateSchema = define("State", () => object({ t: literal("state"), state: HostStateSchema }));
export const SharedUpdateSchema = define(
  "SharedUpdate",
  () => object({ t: literal("shared"), key: string({ minLength: 1 }), value: jsonValueRef }),
);
export const RenderSchema = define("Render", () => object({ t: literal("render"), copy: copyId() }));
/**
 * A device event for handler `handler` of render `n` of the copy (the `tree.n` the bridge took the handler id from).
 * The host runs no handler and answers `event-result {ok:false, stale:true}` when `n` is not the copy's latest sent
 * render or `handler` is not one of its ids — a click racing a re-render never reaches a handler of the newer tree.
 * Without `n` only the handler id is checked.
 */
export const HostEventSchema = define("HostEvent", () =>
  object({
    t: literal("event"),
    copy: copyId(),
    handler: counter(),
    args: array(jsonValueRef),
    origin: OriginSchema,
  }, { n: counter() }));
export const HostCommandSchema = define(
  "HostCommand",
  () => object({ t: literal("command"), copy: copyId(), command: string({ minLength: 1 }), origin: OriginSchema }),
);
export const RpcResultSchema = define(
  "RpcResult",
  () => object({ t: literal("rpc-result"), id: counter(), ok: boolean() }, { value: jsonValueRef, error: string() }),
);
export const CloseSchema = define("Close", () => object({ t: literal("close"), copy: copyId() }));
export const PingSchema = define("Ping", () => object({ t: literal("ping"), n: counter() }));
export const ExitSchema = define("Exit", () => object({ t: literal("exit") }));

/** Every bridge → host line. */
export const BridgeToHostSchema = define("BridgeToHost", () =>
  tagged("t", [
    BootSchema,
    CreateSchema,
    StateSchema,
    SharedUpdateSchema,
    RenderSchema,
    HostEventSchema,
    HostCommandSchema,
    RpcResultSchema,
    CloseSchema,
    PingSchema,
    ExitSchema,
  ]));
export type BridgeToHost = Static<typeof BridgeToHostSchema>;
export type Boot = Static<typeof BootSchema>;
export type Create = Static<typeof CreateSchema>;
export type State = Static<typeof StateSchema>;
export type SharedUpdate = Static<typeof SharedUpdateSchema>;
export type Render = Static<typeof RenderSchema>;
export type HostEvent = Static<typeof HostEventSchema>;
export type HostCommand = Static<typeof HostCommandSchema>;
export type RpcResult = Static<typeof RpcResultSchema>;
export type Close = Static<typeof CloseSchema>;
export type Ping = Static<typeof PingSchema>;
export type Exit = Static<typeof ExitSchema>;

export const BRIDGE_TO_HOST_TYPES = [
  "boot",
  "create",
  "state",
  "shared",
  "render",
  "event",
  "command",
  "rpc-result",
  "close",
  "ping",
  "exit",
] as const;
const _bridgeToHostComplete: Same<(typeof BRIDGE_TO_HOST_TYPES)[number], BridgeToHost["t"]> = true;

// ---------------------------------------------------------------------------------------------------------------------
// Host → bridge.

/** The first line on a connection; anything else first, or nothing within 1 s, drops the connection. */
export const HostHelloSchema = define(
  "HostHello",
  () =>
    object({
      t: literal("hello"),
      token: string({ minLength: 1 }),
      pid: integer({ minimum: 1 }),
      folder: folderName(),
    }),
);
export const LoadedSchema = define(
  "Loaded",
  () => object({ t: literal("loaded"), ms: ms() }, { exports: array(string()), error: string() }),
);
export const CreatedSchema = define("Created", () => object({ t: literal("created"), copy: copyId(), ms: ms() }));
/** One render of one copy: the whole recorded tree (`n` counts renders of that copy); the bridge diffs. */
export const TreeSchema = define(
  "Tree",
  () => object({ t: literal("tree"), copy: copyId(), n: counter(), ms: ms(), tree: RecordedTreeSchema }),
);
export const EmitSchema = define("Emit", () =>
  object(
    { t: literal("emit"), copy: copyId(), method: enumOf(EMIT_METHODS), args: array(jsonValueRef) },
    { origin: OriginSchema },
  ));
export const RpcSchema = define("Rpc", () =>
  object(
    { t: literal("rpc"), id: counter(), copy: copyId(), method: enumOf(RPC_METHODS), args: array(jsonValueRef) },
    { origin: OriginSchema },
  ));
/** The outcome of an `event`; `stale` = no handler ran because `n`/`handler` named an older render. */
export const EventResultSchema = define(
  "EventResult",
  () =>
    object(
      { t: literal("event-result"), copy: copyId(), handler: counter(), ok: boolean() },
      { error: string(), stale: boolean() },
    ),
);
/** A failure in host or mod code; `error` must not carry absolute paths (stripped before any device sees it). */
export const HostErrorSchema = define(
  "HostError",
  () => object({ t: literal("error"), copy: nullable(copyId()), where: string({ minLength: 1 }), error: string() }),
);
export const PongSchema = define(
  "Pong",
  () =>
    object({
      t: literal("pong"),
      n: counter(),
      copies: array(copyId()),
      heap: number({ minimum: 0, description: "bytes" }),
    }),
);

/** Every host → bridge line. */
export const HostToBridgeSchema = define("HostToBridge", () =>
  tagged("t", [
    HostHelloSchema,
    LoadedSchema,
    CreatedSchema,
    TreeSchema,
    EmitSchema,
    RpcSchema,
    EventResultSchema,
    HostErrorSchema,
    PongSchema,
  ]));
export type HostToBridge = Static<typeof HostToBridgeSchema>;
export type HostHello = Static<typeof HostHelloSchema>;
export type Loaded = Static<typeof LoadedSchema>;
export type Created = Static<typeof CreatedSchema>;
export type Tree = Static<typeof TreeSchema>;
export type Emit = Static<typeof EmitSchema>;
export type Rpc = Static<typeof RpcSchema>;
export type EventResult = Static<typeof EventResultSchema>;
export type HostError = Static<typeof HostErrorSchema>;
export type Pong = Static<typeof PongSchema>;

export const HOST_TO_BRIDGE_TYPES = [
  "hello",
  "loaded",
  "created",
  "tree",
  "emit",
  "rpc",
  "event-result",
  "error",
  "pong",
] as const;
const _hostToBridgeComplete: Same<(typeof HOST_TO_BRIDGE_TYPES)[number], HostToBridge["t"]> = true;

/** Either direction (the `t` values do not overlap); for logs and tests. */
export const ControlMessageSchema = define(
  "ControlMessage",
  () => tagged("t", [BridgeToHostSchema, HostToBridgeSchema]),
);
export type ControlMessage = Static<typeof ControlMessageSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Parsing.

/** Validates a parsed bridge → host message. */
export const parseBridgeToHost = (value: unknown): Validation<BridgeToHost> => validate(BridgeToHostSchema, value);
/** Validates a parsed host → bridge message. */
export const parseHostToBridge = (value: unknown): Validation<HostToBridge> => validate(HostToBridgeSchema, value);
/** Parses and validates one bridge → host line (without its `\n`). */
export const decodeBridgeToHost = (line: string): Validation<BridgeToHost> => decode(BridgeToHostSchema, line);
/** Parses and validates one host → bridge line (without its `\n`). */
export const decodeHostToBridge = (line: string): Validation<HostToBridge> => decode(HostToBridgeSchema, line);
