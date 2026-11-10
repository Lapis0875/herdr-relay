/**
 * The view manager (DESIGN-v2 §1.7, §4 T08): device sessions and the mod copies they show.
 *
 * Copies (`./copies.ts`): a mod block starts once a session shows it and stays while the Mac's layout keeps it; pane
 * headers follow the panes of the tab a session shows; overlays come from `openOverlay` and `mod.open`. The host
 * supervisor runs them; this module turns every `tree` into the client `ElementTree` (`toElementTree`), gives its
 * handlers fresh view ids (`./handlers.ts`) and brings devices up to date at most every `flushMs` (16 ms): `view.tree`
 * for a view a device has not seen at the previous version (first render, a host restart, a re-shown view), else
 * one `patch` per device with JSON-patch ops per view (`./diff.ts`), its `state` ops (snapshot) and `screens`.
 *
 * Events: a device `event` names a view and a handler id of that view's latest render; it reaches the copy's host
 * with a fresh origin token for the device's session (`./origins.ts`: raw session ids never reach a host) and that
 * render's number `n`, and is acked when the host's `event-result` comes back (`stale-handler` for ids of an older
 * render or host generation, and when the host has rendered again since — it then runs no handler; `host-down` while
 * the host is away). An `emit`/`rpc` names its device only by a token that folder's current host was handed within its
 * lifetime; any other origin counts as `read` from no device and is logged `origin downgraded` (S19).
 *
 * Resume: a session outlives its socket. A lost socket leaves it detached for `resumeGraceMs` (its copies, navigator
 * and flushes go on). Every message that changes what a device holds (`snapshot`, `patch`, `view.tree`, `overlay`,
 * `overlay.close`) is kept in the session's ring (the last {@link RESUME_RING}); a client `hello {session, since}` from
 * the same paired device, scope and device class gets `hello {resumed: true, seq: since}` and the kept messages after
 * `since` — or, when the ring no longer reaches back to `since`, `hello` + `snapshot` + its overlays + every view as
 * `view.tree`, in the same session. `ack`, `toast`, `look`, `clipboard` and `sound` are not kept (`hello` carries the
 * look).
 *
 * Look, clipboard and sound: `look()` changing after `hello` goes out as `look`; a mod's `write_to_clipboard(text)` as
 * `clipboard` to the device of its origin (without one, the lead's); a mod's `playSound(path)` as `sound` to the
 * device of its origin only (without one, or downgraded, to none), once {@link HerdrData.sound} allowed the file.
 *
 * `run()`: a mod's `run` emit and a device `command` are decided by the device's {@link Session} (DESIGN-v2 §2.4):
 * session commands change that session (navigator, layout clicks, focus, peek, overlays); `<folder>.<command>` reaches
 * the `nextCommand()` of that folder's copies on the device's screen; passthrough goes to {@link HerdrData.passthrough};
 * refusals are acked (commands) or toasted (mod runs). A `run` without an origin (init, render, a timer no device
 * started) acts on no device: a device's navigator, layout clicks and focus change only from its own `nav`, `command`
 * and handler events (Herdr: screens do not share them).
 *
 * Device layout profile (D12, `../session/profiles.ts`): a client `layout` message (one rate unit, applied all or
 * none) and `layout.resize` (a command, or a mod's `run` for the device of its origin) change the profile of that
 * session's paired device, at most {@link LAYOUT_RATE_PER_S} per second per session together (the rest are refused,
 * logged once per burst; a refused mod run is not toasted); the session gets `patch.screens`, and the device's other
 * sessions read the profile again. Every Mac layout edit or switch sends every session `patch.screens` (its `layout`
 * and `resize` nodes). Profiles are removed only by {@link ViewManager.retainDevices} — a device confirmed no longer
 * paired by a successful read of the device list — never by {@link ViewManager.revokeDevice}, which also runs, fail
 * closed, when the list is unreadable.
 *
 * Hosts render one view per copy for every device. The `layout()` and `focused()` they read, and the selection, focus
 * and zoom flags of `spaces()`/`panes()`/`agents()` (Herdr: they belong to each screen), are those of the lead
 * session — the device that acted last — so a click's effects show on the device that clicked (multi-device
 * limitation: other devices see the lead's inside mod views, their own in the ScreenGraph and their `snapshot`).
 *
 * Host error text reaches devices only through {@link PathStripper} (S30).
 */

import {
  type Ack,
  type AckError,
  applyClicks,
  type BridgeHello,
  type ClientEvent,
  type ClientHello,
  type Command,
  type CopyKind,
  type ElementNode,
  type Emit,
  errorNode,
  type EventResult,
  type HostError,
  type HostState,
  type HostStatus,
  is,
  type JsonObject,
  type JsonPatch,
  type JsonValue,
  type LayoutMessage,
  type Nav,
  type Origin,
  type Overlay,
  type OverlayClose,
  type PaneInfo,
  parseCopyId,
  type Patch,
  PROTOCOL_VERSION,
  type Rpc,
  type Snapshot,
  type Toast,
  ToastSchema,
  toElementTree,
  type Tree,
  type ViewTree,
} from "@herdr-relay/protocol";
import { messageOf } from "../core/errors.ts";
import type { HostHandlers, HostRef, HostSupervisor } from "../hosts/mod.ts";
import { logDecision, type PolicyLog } from "../policy/decision.ts";
import type { RequestMessage, SessionConnection, SessionHandler } from "../server/mod.ts";
import { parseAction, type RunContext, type RunOutcome, Session, type SessionOutcome } from "../session/mod.ts";
import { LayoutProfileStore } from "../session/profiles.ts";
import { type CopySpec, layoutBlocks, paneHeaderFolders, shownCopies } from "./copies.ts";
import type { ClientLook, HerdrChange, HerdrData, ResolvedOrigin, SnapshotState } from "./data.ts";
import { diffJson, jsonEqual } from "./diff.ts";
import { bindHandlers, eventArgs, type HandlerEntry } from "./handlers.ts";
import { hostOverlayIdOk, overlayMessage, type OverlaySpec, parseOverlaySpec } from "./overlays.ts";
import { ORIGIN_TTL_MS, OriginTokens } from "./origins.ts";
import { type PathRoot, PathStripper } from "./strip.ts";

/** Devices are brought up to date at most this often (one `patch` per device per flush). */
export const FLUSH_MS = 16;
/** Messages kept per session for a resume (`hello.since`). */
export const RESUME_RING = 512;
/** A session whose socket is gone waits this long for a resume, then ends. */
export const RESUME_GRACE_MS = 120_000;
/**
 * How the server's revocation sweep closes a revoked device's socket (`server/server.ts`): such a session ends at once,
 * without resume grace. The close code a socket reports can differ when the client races its own close, so the sweep
 * should also call {@link ViewManager.revokeDevice}.
 */
export const REVOKED_CLOSE = { code: 1008, reason: "device revoked" } as const;
/** Layout profile changes (client `layout`, `layout.resize` commands and mod runs) one session may make per second. */
export const LAYOUT_RATE_PER_S = 20;
/** Downgraded origins remembered for logging once each; the set starts over when full. */
const DOWNGRADES_NOTED_MAX = 4096;

/** What the view manager drives of the host supervisor. */
export type HostPort = Pick<
  HostSupervisor,
  "create" | "close" | "event" | "command" | "shared" | "stateChanged" | "statuses" | "info"
>;

/** What the host supervisor is created with: the view manager's `stateFor` and message handlers. */
export interface HostWiring {
  stateFor(folder: string): HostState;
  handlers: HostHandlers;
}

export interface ViewManagerOptions {
  data: HerdrData;
  /** Creates the host supervisor with the wiring (e.g. `(w) => HostSupervisor.create({...paths, ...w})`). */
  hosts(wiring: HostWiring): HostPort | Promise<HostPort>;
  /** Absolute directories to label in device-visible host errors (appHome → "", modhost → "modhost/", …). */
  roots: readonly PathRoot[];
  /**
   * Gets every socket's `open`/`close` after the view manager, the messages it does not handle (`term.open`,
   * `term.close`, `visible`, `push.sub`) and binary frames (T11). Without it those requests are acked `refused`.
   */
  next?: SessionHandler;
  log?: (line: string) => void;
  flushMs?: number;
  /** Default {@link RESUME_GRACE_MS}. */
  resumeGraceMs?: number;
  /** Receives the `origin` decisions (a downgraded host origin); the bridge passes `fileLog(<state>)`. */
  policyLog?: PolicyLog;
  /** How long a host may use an origin token after its delivery; default {@link ORIGIN_TTL_MS} (tests shorten it). */
  originTtlMs?: number;
  /** The devices' layout profiles (`LayoutProfileStore.open(<state>)`); default: kept in memory for this run. */
  profiles?: LayoutProfileStore;
}

interface Pending {
  device: Device;
  id: number;
}

/** One copy as devices see it. */
interface ViewState {
  readonly copy: string;
  readonly folder: string;
  readonly kind: CopyKind;
  /** The id part of the copy (block id, pane id or overlay id). */
  readonly local: string;
  spec: CopySpec;
  /** The latest tree, with view handler ids; null until the first render (or an error block). */
  tree: ElementNode | null;
  /** The host render (`tree.n`) `handlers` belong to; every event names it. */
  n: number;
  /** The tree devices were brought to at the last flush that changed it. */
  flushed: ElementNode | null;
  /** Grows at every flush that changed the tree. */
  version: number;
  /** Ops from `version - 1` to `version`; null when devices need the whole tree. */
  ops: JsonPatch | null;
  /** The next change goes out as `view.tree` (first tree, new host generation, error block). */
  reset: boolean;
  dirty: boolean;
  /** View handler id → host handler of the latest render. */
  handlers: Map<number, HandlerEntry>;
  /** The handler ids belong to the running host generation. */
  live: boolean;
  /** Device events sent to the host, by host handler id, in order (acked by `event-result`). */
  pending: Map<number, Pending[]>;
  /** Dropped-call count last logged. */
  diagnostics: number;
}

/** A message that changes what a device holds: kept for a resume. */
type Held = Snapshot | Patch | ViewTree | Overlay | OverlayClose;

/** One device session; its socket can go and be replaced (resume). */
interface Device {
  /** The session id (`hello.session`: the id of the socket that started it). */
  readonly id: string;
  /** The paired device's id; only it may resume the session. */
  readonly device: string;
  /** The current socket; null while detached. */
  conn: SessionConnection | null;
  readonly session: Session;
  seq: number;
  /** Copies on screen: blocks, pane headers (with specs), overlays. */
  blocks: Set<string>;
  panes: Map<string, CopySpec>;
  shown: Set<string>;
  /** Overlay ids open here, oldest first. */
  overlays: string[];
  /** View → version this device holds. */
  sent: Map<string, number>;
  snapshot: SnapshotState;
  /** `patch.screens` due. */
  screens: boolean;
  /** The snapshot may have changed (`patch.state`). */
  state: boolean;
  /** The look this device holds (`hello`, `look`). */
  look: ClientLook;
  /** Held messages, oldest first; `at` is the `seq` the device had before the message went out. */
  ring: { at: number; msg: Held }[];
  /** `at` of the newest message dropped from `ring`: a resume needs `since` above it. */
  evicted: number;
  /** Ends the session while detached. */
  expiry: ReturnType<typeof setTimeout> | undefined;
  activeAt: number;
  /** Times of the layout profile changes of the last second; `dropped`: the current burst was logged. */
  layoutRate: { times: number[]; dropped: boolean };
}

interface OverlayState {
  readonly id: string;
  readonly copy: string;
  readonly spec: OverlaySpec;
  readonly msg: Overlay;
  readonly devices: Set<Device>;
  /** Opened by `mod.open` (which toggles), not by a mod's `openOverlay`. */
  readonly modOpen: boolean;
}

type Reply = (ok: boolean, error?: AckError, message?: string) => void;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const asJson = (v: unknown) => v as JsonValue;
const TOAST_LEVELS: Record<string, NonNullable<Toast["level"]>> = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
};

function sameSpec(a: CopySpec, b: CopySpec): boolean {
  return jsonEqual(a.props, b.props) && jsonEqual(asJson(a.placement), asJson(b.placement));
}

export class ViewManager implements SessionHandler {
  readonly #data: HerdrData;
  readonly #next: SessionHandler | null;
  readonly #log: (line: string) => void;
  readonly #strip: PathStripper;
  readonly #flushMs: number;
  readonly #resumeGraceMs: number;
  #hosts!: HostPort;
  readonly #views = new Map<string, ViewState>();
  /** Sessions by session id, attached or detached. */
  readonly #devices = new Map<string, Device>();
  /** Attached sessions by socket id. */
  readonly #byConn = new Map<string, Device>();
  readonly #overlays = new Map<string, OverlayState>();
  /** The running host generation per folder (0 while none runs). */
  readonly #generations = new Map<string, number>();
  /** Folders whose `focus` emits were logged as dropped. */
  readonly #focusNoted = new Set<string>();
  /** `<copy>\0<name>` of origin-less `run`s already logged as ignored. */
  readonly #originlessNoted = new Set<string>();
  /** Folders whose `playSound` without a device origin was logged as dropped. */
  readonly #soundNoted = new Set<string>();
  readonly #policyLog: PolicyLog | null;
  /** Origin tokens handed to hosts with events and commands. */
  readonly #origins: OriginTokens;
  /** `<folder>\0<token>\0<reason>` of downgraded origins already logged (bounded). */
  readonly #downgradeNoted = new Set<string>();
  #lead: Device | null = null;
  #layoutName: string;
  #handlerSeq = 0;
  #overlaySeq = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | null = null;
  #stopped = false;
  /** `look()` may have changed since the last flush. */
  #lookDue = false;
  readonly #profiles: LayoutProfileStore;

  private constructor(o: ViewManagerOptions) {
    this.#data = o.data;
    this.#next = o.next ?? null;
    this.#log = o.log ?? ((line) => console.error(`herdr-relay views: ${line}`));
    this.#strip = new PathStripper(o.roots);
    this.#flushMs = o.flushMs ?? FLUSH_MS;
    this.#resumeGraceMs = o.resumeGraceMs ?? RESUME_GRACE_MS;
    this.#policyLog = o.policyLog ?? null;
    this.#origins = new OriginTokens(o.originTtlMs ?? ORIGIN_TTL_MS);
    this.#layoutName = o.data.layout().layout.name;
    this.#profiles = o.profiles ?? LayoutProfileStore.memory();
  }

  /** Creates the view manager and its host supervisor (through `o.hosts`), then follows `o.data`. */
  static async start(o: ViewManagerOptions): Promise<ViewManager> {
    const vm = new ViewManager(o);
    vm.#hosts = await o.hosts({ stateFor: (folder) => vm.#stateFor(folder), handlers: vm.#hostHandlers() });
    vm.#unsubscribe = o.data.subscribe((change) => vm.#changed(change));
    return vm;
  }

  /** A session (its scope, focus, layout and navigator) by socket id or by session id (`hello.session`). */
  session(id: string): Session | undefined {
    return (this.#byConn.get(id) ?? this.#devices.get(id))?.session;
  }

  /** Stops flushing, following data changes and waiting for resumes; the host supervisor is stopped by its owner. */
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const d of this.#devices.values()) clearTimeout(d.expiry);
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Device sockets (SessionHandler).

  open(conn: SessionConnection, hello: ClientHello): void | Promise<void> {
    if (this.#stopped) return conn.close(1013, "the bridge is stopping");
    const prev = hello.session === undefined ? undefined : this.#devices.get(hello.session);
    // Only the paired device that held the session may take it over, and only while no socket holds it.
    const own = prev && prev.conn === null && prev.device === conn.device.id ? prev : undefined;
    if (
      own && hello.since !== undefined && own.session.scope === conn.device.scope && own.session.device === hello.class
    ) {
      this.#attach(own, conn);
      this.#resume(own, hello.since);
    } else {
      if (own) this.#end(own);
      this.#begin(conn, hello);
    }
    this.#ensureLead();
    this.#refresh();
    return this.#next?.open(conn, hello);
  }

  message(conn: SessionConnection, msg: RequestMessage): void | Promise<void> {
    const d = this.#byConn.get(conn.id);
    if (!d) return;
    switch (msg.t) {
      case "nav":
        return this.#nav(d, msg);
      case "event":
        return this.#event(d, msg);
      case "command":
        return this.#command(d, msg);
      case "layout":
        return this.#layout(d, msg);
    }
    if (this.#next) return this.#next.message(conn, msg);
    if ("id" in msg) this.#ack(d, msg.id, false, "refused", "not available");
  }

  binary(conn: SessionConnection, frame: Uint8Array): void | Promise<void> {
    return this.#next?.binary(conn, frame);
  }

  /**
   * The socket is gone; its session waits for a resume and ends after the grace time — at once when the server closed
   * it because its device was revoked ({@link REVOKED_CLOSE}; {@link revokeDevice} is the direct way). Tokens
   * delivered over this socket count as `read` from now on, also after a resume.
   */
  close(conn: SessionConnection, code: number, reason: string): void {
    const d = this.#byConn.get(conn.id);
    if (d) {
      this.#byConn.delete(conn.id);
      d.conn = null;
      if (code === REVOKED_CLOSE.code && reason === REVOKED_CLOSE.reason) {
        this.#log(`session ${d.id}: device revoked; session ended without resume grace`);
        this.#end(d);
      } else {
        d.expiry = setTimeout(() => this.#end(d), this.#resumeGraceMs);
      }
      this.#ensureLead();
    }
    this.#next?.close(conn, code, reason);
  }

  /**
   * A paired device was revoked, or the device list cannot be read (fail closed): every session of it ends now (no
   * resume grace), its socket is closed with {@link REVOKED_CLOSE} and the origin tokens of those sessions are
   * forgotten. Its device-local state (layout profile) stays: only {@link retainDevices} removes it, after a successful
   * read confirms the device is gone.
   */
  revokeDevice(deviceId: string): void {
    for (const d of [...this.#devices.values()]) {
      if (d.device !== deviceId) continue;
      const conn = d.conn;
      if (conn) this.#byConn.delete(conn.id);
      d.conn = null;
      this.#end(d);
      conn?.close(REVOKED_CLOSE.code, REVOKED_CLOSE.reason);
    }
    this.#ensureLead();
  }

  /**
   * The device list was read successfully: removes the layout profiles of devices `paired` does not name (the caller
   * keeps the loopback identity, and never calls this while the list is unreadable).
   */
  retainDevices(paired: (deviceId: string) => boolean): void {
    this.#profiles.retain(paired);
  }

  /** A new session for `conn`. */
  #begin(conn: SessionConnection, hello: ClientHello): void {
    const { layout, clicks } = this.#data.layout();
    const session = new Session({
      id: conn.id,
      scope: conn.device.scope,
      device: hello.class,
      layout,
      clicks,
      world: () => this.#data.world(),
      profile: this.#profiles.device(conn.device.id),
    });
    const d: Device = {
      id: conn.id,
      device: conn.device.id,
      conn: null,
      session,
      seq: 0,
      blocks: new Set(),
      panes: new Map(),
      shown: new Set(),
      overlays: [],
      sent: new Map(),
      snapshot: this.#snapshotFor(conn.id, session),
      screens: false,
      state: false,
      look: this.#data.look(),
      ring: [],
      evicted: 0,
      expiry: undefined,
      activeAt: Date.now(),
      layoutRate: { times: [], dropped: false },
    };
    this.#devices.set(d.id, d);
    this.#attach(d, conn);
    this.#resend(d, d.snapshot);
  }

  #attach(d: Device, conn: SessionConnection): void {
    clearTimeout(d.expiry);
    d.expiry = undefined;
    d.conn = conn;
    this.#byConn.set(conn.id, d);
  }

  /** The client holds the session up to `since`: the kept messages after it, or everything again. */
  #resume(d: Device, since: number): void {
    d.look = this.#data.look();
    if (since > d.seq || since <= d.evicted) return this.#resend(d);
    this.#greet(d, since, true);
    for (const e of d.ring) if (e.at >= since) d.conn?.send(e.msg);
  }

  /**
   * Everything, as to a new session: `hello`, `snapshot`, its overlays, and every view as `view.tree` at the next flush.
   * No earlier `since` can resume after this.
   */
  #resend(d: Device, snapshot: SnapshotState = this.#snapshotFor(d.id, d.session)): void {
    d.ring = [];
    d.evicted = d.seq;
    this.#greet(d, ++d.seq, false);
    d.snapshot = snapshot;
    d.state = false;
    d.screens = false;
    this.#post(d, { t: "snapshot", seq: ++d.seq, ...snapshot });
    for (const id of d.overlays) {
      const o = this.#overlays.get(id);
      if (o) this.#post(d, o.msg);
    }
    d.sent.clear();
  }

  /** The bridge `hello` (never kept: every resume gets a new one). */
  #greet(d: Device, seq: number, resumed: boolean): void {
    // Host reasons are device-visible (S30).
    const hosts = this.#hosts.statuses().map((s) =>
      s.reason === undefined ? s : { ...s, reason: this.#strip.line(s.reason) }
    );
    const msg: BridgeHello = {
      t: "hello",
      v: PROTOCOL_VERSION,
      seq,
      session: d.id,
      layout: d.session.layout,
      screens: d.session.graph,
      theme: d.look.theme,
      settings: d.look.settings,
      fonts: d.look.fonts,
      scope: d.session.scope,
      hosts,
    };
    if (resumed) msg.resumed = true;
    const compat = this.#data.compat?.();
    if (compat) msg.compat = compat;
    d.conn?.send(msg);
  }

  /** Sends a message that changes what the device holds, and keeps it for a resume. */
  #post(d: Device, msg: Held): void {
    d.ring.push({ at: "seq" in msg ? msg.seq - 1 : d.seq, msg });
    if (d.ring.length > RESUME_RING) d.evicted = d.ring.shift()!.at;
    d.conn?.send(msg);
  }

  /** The session is over (detached past the grace time, revoked, or given up by its device): overlays, D8 data, copies. */
  #end(d: Device): void {
    clearTimeout(d.expiry);
    d.expiry = undefined;
    if (this.#devices.get(d.id) !== d) return;
    this.#devices.delete(d.id);
    this.#origins.forget(d.id);
    for (const o of [...this.#overlays.values()]) {
      if (o.devices.delete(d) && o.devices.size === 0) this.#destroyOverlay(o);
    }
    if (this.#lead === d) this.#setLead(this.#pickLead());
    this.#data.sessionClosed(d.id);
    this.#refresh();
  }

  #nav(d: Device, msg: Nav): void {
    this.#touch(d);
    const o = d.session.nav(msg);
    this.#apply(d, o);
    this.#refresh();
    this.#ack(d, msg.id, o.ok, o.error, o.message);
  }

  #event(d: Device, ev: ClientEvent): void {
    this.#touch(d);
    const v = this.#views.get(ev.view);
    if (!v || !d.sent.has(ev.view)) return this.#ack(d, ev.id, false, "refused", `no view ${ev.view} on this device`);
    const entry = v.live ? v.handlers.get(ev.handler) : undefined;
    if (!entry) {
      return v.live
        ? this.#ack(d, ev.id, false, "stale-handler", "the view has re-rendered")
        : this.#ack(d, ev.id, false, "host-down", `${v.folder} is not running`);
    }
    const r = eventArgs(entry, ev);
    if (!r.ok) return this.#ack(d, ev.id, false, "refused", r.message);
    const origin = this.#tokenFor(d, v.folder);
    if (!this.#hosts.event(v.copy, entry.host, r.args, origin, v.n)) {
      this.#origins.revoke(origin);
      return this.#ack(d, ev.id, false, "host-down", `${v.folder} is not running`);
    }
    const pending = { device: d, id: ev.id };
    const queue = v.pending.get(entry.host);
    if (queue) queue.push(pending);
    else v.pending.set(entry.host, [pending]);
  }

  #command(d: Device, msg: Command): void {
    this.#touch(d);
    if (this.#isResize(msg.name, msg.args) && !this.#admitLayout(d)) {
      return this.#ack(d, msg.id, false, "refused", `over ${LAYOUT_RATE_PER_S} layout changes per second`);
    }
    const out = d.session.run(msg.name, msg.args, this.#runContext());
    this.#outcome(d, out, this.#originOf(d), (ok, error, message) => this.#ack(d, msg.id, ok, error, message));
  }

  /** A client `layout` message: this device's layout profile (D12); also from `read` devices (their own view only). */
  #layout(d: Device, msg: LayoutMessage): void {
    this.#touch(d);
    if (!this.#admitLayout(d)) {
      return this.#ack(d, msg.id, false, "refused", `over ${LAYOUT_RATE_PER_S} layout changes per second`);
    }
    const o = d.session.layoutProfile(msg);
    this.#apply(d, o);
    this.#refresh();
    this.#ack(d, msg.id, o.ok, o.error, o.message);
  }

  /** Whether a `run()`/`command` name (keys.json shorthand resolved) is `layout.resize`. */
  #isResize(name: string, args: JsonObject | undefined): boolean {
    return parseAction(name, args, this.#data.commands()).name === "layout.resize";
  }

  /** Counts one layout profile change of `d`'s session; `false` over {@link LAYOUT_RATE_PER_S} (logged per burst). */
  #admitLayout(d: Device): boolean {
    const now = Date.now();
    const rate = d.layoutRate;
    rate.times = rate.times.filter((t) => now - t < 1000);
    if (rate.times.length >= LAYOUT_RATE_PER_S) {
      if (!rate.dropped) this.#log(`session ${d.id}: layout changes over ${LAYOUT_RATE_PER_S}/s; refused`);
      rate.dropped = true;
      return false;
    }
    rate.times.push(now);
    rate.dropped = false;
    return true;
  }

  /** Carries out a `run()` decision for device `d`; `reply` gets the result. */
  #outcome(d: Device, out: RunOutcome, origin: ResolvedOrigin, reply: Reply): void {
    switch (out.class) {
      case "session":
        this.#apply(d, out);
        this.#refresh();
        return reply(out.ok, out.error, out.message);
      case "mod": {
        // `<mod>.<command>` reaches the copies of that folder on this device's screen only.
        let found = false;
        let sent = false;
        for (const copy of d.shown) {
          if (this.#views.get(copy)?.folder !== out.folder) continue;
          found = true;
          const token = this.#tokenFor(d, out.folder);
          if (this.#hosts.command(copy, out.command, token)) sent = true;
          else this.#origins.revoke(token);
        }
        if (!found) return reply(false, "refused", `${out.folder} is not on this screen`);
        return sent ? reply(true) : reply(false, "host-down", `${out.folder} is not running`);
      }
      case "passthrough":
        this.#data.passthrough(out.name, out.args, origin).then(
          () => reply(true),
          (e) => reply(false, "refused", this.#strip.line(messageOf(e))),
        );
        return;
      case "refused":
        return reply(false, out.error, out.message);
    }
  }

  /**
   * Applies a session change: screens, snapshot, host state (lead), overlays; a changed layout profile is read again by
   * the device's other sessions. The caller refreshes.
   */
  #apply(d: Device, o: SessionOutcome): void {
    if (o.changed.screens) d.screens = true;
    if (o.changed.focus) d.state = true;
    if ((o.changed.layout || o.changed.focus) && this.#lead === d) this.#hosts.stateChanged();
    for (const e of o.effects) {
      if (e.kind === "overlay.open") this.#modOpen(d, e.mod);
      else this.#closeFor(d, e.id);
    }
    if (!o.changed.profile) return;
    for (const x of this.#devices.values()) {
      if (x !== d && x.device === d.device) this.#apply(x, x.session.reloadProfile());
    }
  }

  /** `d` acted: it becomes the lead session (the one hosts render for). */
  #touch(d: Device): void {
    d.activeAt = Date.now();
    if (this.#lead !== d) this.#setLead(d);
  }

  #setLead(d: Device | null): void {
    this.#lead = d;
    this.#hosts.stateChanged();
  }

  /** A socket came or went: the lead stays attached while any session is (a detached one only when none is). */
  #ensureLead(): void {
    if (this.#lead?.conn) return;
    const next = this.#pickLead();
    if (next !== this.#lead) this.#setLead(next);
  }

  /** The most recently active attached session, else the most recently active detached one. */
  #pickLead(): Device | null {
    let best: Device | null = null;
    for (const x of this.#devices.values()) {
      if (
        best === null || (x.conn !== null && best.conn === null) ||
        ((x.conn === null) === (best.conn === null) && x.activeAt > best.activeAt)
      ) best = x;
    }
    return best;
  }

  #ack(d: Device, id: number, ok: boolean, error?: AckError, message?: string): void {
    const msg: Ack = { t: "ack", id, ok };
    if (!ok) {
      msg.error = error ?? "refused";
      if (message) msg.message = message;
    }
    d.conn?.send(msg);
  }

  #toast(d: Device, title: string, level: NonNullable<Toast["level"]> = "warning"): void {
    d.conn?.send({ t: "toast", title, level });
  }

  #runContext(): RunContext {
    return { modFolders: new Set([...this.#views.values()].map((v) => v.folder)), commands: this.#data.commands() };
  }

  /** `d` as an origin: its scope while it has an open socket; `read` and not connected while detached. */
  #originOf(d: Device): ResolvedOrigin {
    return d.conn !== null
      ? { session: d.id, scope: d.session.scope, connected: true }
      : { session: d.id, scope: "read", connected: false };
  }

  /** A fresh origin token for one delivery of `d`'s event or command, over its open socket, to `folder`'s host. */
  #tokenFor(d: Device, folder: string): Origin {
    return this.#origins.mint(d.id, d.conn?.id ?? "", folder, this.#generations.get(folder) ?? 0);
  }

  /**
   * Origin plumbing (S19): a host call names its device only by a token that folder's current host was handed with an
   * event or command within its lifetime (`./origins.ts`), and only while the socket it was delivered for is still the
   * session's open one. Any other token — unknown (a forged or raw session id, a revoked device's), expired, another
   * folder's, an earlier host's, one whose session has ended, is not connected, or has reconnected since — is `read`
   * from no device, logged `origin downgraded` (once per token and reason) and recorded in the policy log (rule `origin`).
   */
  #resolve(h: HostRef, m: Emit | Rpc): ResolvedOrigin | null {
    if (m.origin === undefined) return null;
    const token = m.origin.session;
    const c = this.#origins.check(token, h.folder, h.generation);
    let reason: string;
    if (!c.ok) reason = c.reason;
    else {
      const d = this.#devices.get(c.session);
      if (d === undefined) reason = "its session has ended";
      else if (d.conn === null) reason = "session not connected";
      else if (d.conn.id !== c.conn) reason = "token from before the session reconnected";
      else return this.#originOf(d);
    }
    const key = `${h.folder}\0${token}\0${reason}`;
    if (!this.#downgradeNoted.has(key)) {
      if (this.#downgradeNoted.size >= DOWNGRADES_NOTED_MAX) this.#downgradeNoted.clear();
      this.#downgradeNoted.add(key);
      this.#log(`origin downgraded: ${m.copy} ${m.t} ${m.method} (${reason}); counted as read from no device`);
      if (this.#policyLog) {
        logDecision(this.#policyLog, {
          folder: h.folder,
          method: m.method,
          argv: [m.copy],
          decision: "refuse",
          rule: "origin",
          reason: `origin downgraded: ${reason}`,
        });
      }
    }
    return { session: token, scope: "read", connected: false };
  }

  /** Who sees an overlay or a notification: the origin's device, every device without an origin, none if stale. */
  #recipients(origin: ResolvedOrigin | null): Device[] {
    if (origin === null) return [...this.#devices.values()];
    const d = origin.connected ? this.#devices.get(origin.session) : undefined;
    return d ? [d] : [];
  }

  #snapshotFor(id: string, session: Session): SnapshotState {
    return { ...this.#data.snapshot(id), ...session.view() };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Host state and data changes.

  #stateFor(folder: string): HostState {
    const lead = this.#lead;
    const base = this.#data.hostState(folder, lead?.id ?? null);
    if (lead === null) return base;
    return { ...base, ...lead.session.view(), layout: lead.session.layout.tree };
  }

  #changed(c: HerdrChange): void {
    if (this.#stopped) return;
    switch (c.kind) {
      case "layout": {
        const { layout, clicks } = this.#data.layout();
        if (layout.name !== this.#layoutName) {
          // Another layout starts its mods fresh (pane headers belong to their tab and stay).
          this.#layoutName = layout.name;
          for (const o of [...this.#overlays.values()]) this.#destroyOverlay(o);
          for (const v of [...this.#views.values()]) if (v.kind === "block") this.#closeView(v);
        }
        for (const d of this.#devices.values()) {
          this.#apply(d, d.session.setLayout(layout, clicks));
          // The graph names the layout shown now and its `resize` nodes; the client relies on it, not on `hello`.
          d.screens = true;
        }
        this.#hosts.stateChanged();
        this.#refresh();
        return;
      }
      case "state":
        this.#hosts.stateChanged();
        this.#lookDue = true;
        for (const d of this.#devices.values()) d.state = true;
        this.#refresh();
        return;
      case "shared":
        if (c.session === null || c.session === this.#lead?.id) this.#hosts.shared(c.key, c.value);
        for (const d of this.#devices.values()) if (c.session === null || c.session === d.id) d.state = true;
        this.#schedule();
        return;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Copies.

  /** Recomputes what every device shows, creates and closes copies accordingly, and schedules a flush. */
  #refresh(): void {
    const world = this.#data.world();
    for (const d of this.#devices.values()) {
      const tab = d.session.focused()?.tab;
      const panes: PaneInfo[] = tab ? world.panes.filter((p) => p.tab === tab) : [];
      const s = shownCopies(d.session.graph, panes);
      d.blocks = s.blocks;
      d.panes = s.panes;
      d.shown = new Set([...s.blocks, ...s.panes.keys()]);
      for (const id of d.overlays) {
        const o = this.#overlays.get(id);
        if (o) d.shown.add(o.copy);
      }
    }
    this.#reconcile(new Set(world.panes.map((p) => p.pane)));
    this.#schedule();
  }

  #reconcile(paneIds: Set<string>): void {
    const { layout, clicks } = this.#data.layout();
    const tree = applyClicks(layout.tree, clicks);
    const blocks = layoutBlocks(tree);
    const headers = paneHeaderFolders(tree);
    for (const v of [...this.#views.values()]) {
      if (v.kind === "block") {
        const spec = blocks.get(v.copy);
        if (!spec) this.#closeView(v);
        else if (!sameSpec(spec, v.spec)) this.#recreateView(v, spec);
      } else if (v.kind === "pane" && (!headers.has(v.folder) || !paneIds.has(v.local))) {
        this.#closeView(v);
      }
    }
    for (const d of this.#devices.values()) {
      for (const copy of d.blocks) {
        const spec = this.#views.has(copy) ? undefined : blocks.get(copy);
        if (spec) this.#openView(copy, spec);
      }
      for (const [copy, spec] of d.panes) {
        const v = this.#views.get(copy);
        if (!v) this.#openView(copy, spec);
        else if (!sameSpec(spec, v.spec)) this.#recreateView(v, spec);
      }
    }
  }

  #openView(copy: string, spec: CopySpec): void {
    const ref = parseCopyId(copy);
    if (ref === null) return this.#log(`not a copy id: ${JSON.stringify(copy)}`);
    const v: ViewState = {
      copy,
      folder: ref.folder,
      kind: ref.kind,
      local: ref.id,
      spec,
      tree: null,
      n: 0,
      flushed: null,
      version: 0,
      ops: null,
      reset: true,
      dirty: false,
      handlers: new Map(),
      live: false,
      pending: new Map(),
      diagnostics: 0,
    };
    this.#views.set(copy, v);
    const status = this.#hosts.info(ref.folder)?.status;
    if (status?.state === "failed") this.#failView(v, status.reason);
    try {
      this.#hosts.create(copy, spec.props, spec.placement);
    } catch (e) {
      this.#log(`${copy}: cannot create: ${messageOf(e)}`);
      this.#failView(v, "the mod cannot start");
    }
  }

  /** The block's props (or placement) changed: the copy starts over with the new ones. */
  #recreateView(v: ViewState, spec: CopySpec): void {
    v.spec = spec;
    v.handlers = new Map();
    v.live = false;
    v.reset = true;
    this.#hosts.create(v.copy, spec.props, spec.placement);
  }

  #closeView(v: ViewState): void {
    this.#views.delete(v.copy);
    this.#hosts.close(v.copy);
    this.#settle(v, "refused", "the view closed");
    for (const d of this.#devices.values()) d.sent.delete(v.copy);
  }

  /** The view shows a `k:"error"` block (host failed, refused folder, render failure before any tree). */
  #failView(v: ViewState, reason: string | undefined): void {
    v.tree = errorNode(this.#strip.line(reason ?? "the mod is not available"), v.folder);
    v.handlers = new Map();
    v.live = false;
    v.reset = true;
    v.dirty = true;
    this.#schedule();
  }

  /** Acks every event still waiting for the view's host. */
  #settle(v: ViewState, error: AckError, message: string): void {
    for (const queue of v.pending.values()) for (const p of queue) this.#ack(p.device, p.id, false, error, message);
    v.pending.clear();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Overlays.

  #createOverlay(id: string, spec: OverlaySpec, devices: Device[], modOpen: boolean): void {
    const copy = `${spec.mod}:overlay:${id}`;
    const msg = overlayMessage(id, copy, spec);
    if (msg === null || parseCopyId(copy)?.kind !== "overlay") return this.#log(`overlay ${id}: invalid`);
    const o: OverlayState = { id, copy, spec, msg, devices: new Set(devices), modOpen };
    this.#overlays.set(id, o);
    this.#openView(copy, { props: { ...spec.props, overlay: id }, placement: null });
    for (const d of devices) {
      d.overlays.push(id);
      this.#post(d, msg);
    }
    this.#refresh();
  }

  /** Closes an overlay everywhere (`closeOverlay`, its last device left, a layout switch). */
  #destroyOverlay(o: OverlayState): void {
    if (!this.#overlays.delete(o.id)) return;
    for (const d of o.devices) {
      d.overlays = d.overlays.filter((x) => x !== o.id);
      this.#post(d, { t: "overlay.close", id: o.id });
    }
    o.devices.clear();
    const v = this.#views.get(o.copy);
    if (v) this.#closeView(v);
    this.#refresh();
  }

  /** `overlay.close {id?}` from a session: that overlay, or its top dialog/popup (Esc), on this device only. */
  #closeFor(d: Device, id: string | undefined): void {
    let o: OverlayState | undefined;
    if (id !== undefined) o = this.#overlays.get(id);
    else {
      for (let i = d.overlays.length - 1; i >= 0 && o === undefined; i--) {
        const x = this.#overlays.get(d.overlays[i]);
        if (x && x.spec.kind !== "window") o = x;
      }
    }
    if (!o || !o.devices.has(d)) return;
    o.devices.delete(d);
    d.overlays = d.overlays.filter((x) => x !== o.id);
    this.#post(d, { t: "overlay.close", id: o.id });
    if (o.devices.size === 0) this.#destroyOverlay(o);
  }

  /** `mod.open {name}`: opens the mod as a dialog on this device; again closes it. */
  #modOpen(d: Device, name: string): void {
    for (const o of this.#overlays.values()) {
      if (o.modOpen && o.spec.mod === name && o.devices.has(d)) return this.#closeFor(d, o.id);
    }
    const spec = parseOverlaySpec({ mod: name }, (mod) => this.#data.overlayFor?.(mod) ?? "device");
    if (typeof spec === "string") return this.#toast(d, spec);
    this.#createOverlay(`mod-open-${++this.#overlaySeq}`, spec, [d], true);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Host messages.

  #hostHandlers(): HostHandlers {
    return {
      status: (s) => this.#status(s),
      started: (h) => this.#started(h),
      exited: (h) => this.#exited(h),
      tree: (h, m) => this.#tree(h, m),
      emit: (h, m) => this.#emit(h, m),
      rpc: (h, m) => this.#data.rpc(h, m, this.#resolve(h, m)),
      eventResult: (_h, m) => this.#eventResult(m),
      error: (h, m) => this.#hostError(h, m),
    };
  }

  #viewsOf(folder: string): ViewState[] {
    return [...this.#views.values()].filter((v) => v.folder === folder);
  }

  #status(s: HostStatus): void {
    if (s.state !== "failed") return;
    for (const v of this.#viewsOf(s.folder)) {
      this.#settle(v, "host-down", `${s.folder} is not running`);
      this.#failView(v, s.reason);
    }
  }

  /** A new host generation loaded: earlier handler ids are void; its first tree of each copy goes out whole. */
  #started(h: HostRef): void {
    this.#generations.set(h.folder, h.generation);
    for (const v of this.#viewsOf(h.folder)) {
      v.handlers = new Map();
      v.live = false;
      v.reset = true;
    }
  }

  #exited(h: HostRef): void {
    if (this.#generations.get(h.folder) === h.generation) this.#generations.set(h.folder, 0);
    for (const v of this.#viewsOf(h.folder)) {
      v.handlers = new Map();
      v.live = false;
      this.#settle(v, "host-down", `${h.folder} is restarting`);
    }
  }

  #tree(h: HostRef, m: Tree): void {
    const v = this.#views.get(m.copy);
    if (!v || this.#generations.get(h.folder) !== h.generation) return;
    const { tree, diagnostics } = toElementTree(m.tree);
    if (diagnostics.length !== v.diagnostics) {
      v.diagnostics = diagnostics.length;
      const first = diagnostics[0];
      if (first) {
        this.#log(
          `${m.copy}: ${diagnostics.length} recorded call(s) dropped (${first.path} ${first.method}: ${first.message})`,
        );
      }
    }
    v.handlers = bindHandlers(tree, () => ++this.#handlerSeq);
    v.n = m.n;
    v.tree = tree;
    v.live = true;
    v.dirty = true;
    this.#schedule();
  }

  #eventResult(m: EventResult): void {
    const v = this.#views.get(m.copy);
    const queue = v?.pending.get(m.handler);
    const p = queue?.shift();
    if (queue?.length === 0) v!.pending.delete(m.handler);
    if (!p) return;
    if (m.ok) return this.#ack(p.device, p.id, true);
    // `stale`: the host had rendered again (or dropped the id) and ran nothing.
    this.#ack(
      p.device,
      p.id,
      false,
      m.stale ? "stale-handler" : "refused",
      this.#strip.line(m.error ?? "the handler failed"),
    );
  }

  #hostError(h: HostRef, m: HostError): void {
    this.#log(`${h.folder}#${h.generation} ${m.where}${m.copy ? ` ${m.copy}` : ""}: ${m.error.split("\n", 1)[0]}`);
    if (m.copy === null || (m.where !== "render" && m.where !== "tree")) return;
    const v = this.#views.get(m.copy);
    // Herdr keeps the last good render on a failed one; a copy that never rendered shows the error.
    if (v && v.tree === null) this.#failView(v, m.error);
  }

  #emit(h: HostRef, m: Emit): void {
    const origin = this.#resolve(h, m);
    switch (m.method) {
      case "run":
        return this.#emitRun(m, origin);
      case "openOverlay":
        return this.#openOverlay(h, m, origin);
      case "closeOverlay": {
        const o = typeof m.args[0] === "string" ? this.#overlays.get(m.args[0]) : undefined;
        if (o) this.#destroyOverlay(o);
        return;
      }
      case "notify":
        return this.#notify(m, origin);
      case "write_to_clipboard":
        return this.#clipboard(m, origin);
      case "playSound":
        return this.#sound(h, m, origin);
      case "focus":
        // A focus handle's `focus()`: devices keep their own keyboard focus; there is no message for it.
        if (!this.#focusNoted.has(h.folder)) {
          this.#focusNoted.add(h.folder);
          this.#log(`${h.folder}: focus() is not forwarded to devices`);
        }
        return;
      default:
        return this.#data.emit(h, m, origin);
    }
  }

  /**
   * A mod's `run(name, args)`: decided by the session of its origin — the device whose event, command or resumed task
   * led to the call. A `run` without an origin (from `init`, `render`, a timer or task no device started) acts on no
   * device: navigation, layout clicks and focus belong to each screen (Herdr), and the Mac window is not ours to drive
   * (`tabs` restoring a space's panel from its `localStorage` while rendering once closed every phone's panel route).
   * `layout.resize` over the session's {@link LAYOUT_RATE_PER_S} is dropped without a toast.
   */
  #emitRun(m: Emit, origin: ResolvedOrigin | null): void {
    const [name, args] = m.args;
    if (typeof name !== "string" || name === "") return this.#log(`${m.copy}: run without a command name`);
    if (origin === null) {
      const key = `${m.copy}\0${name}`;
      if (!this.#originlessNoted.has(key)) {
        this.#originlessNoted.add(key);
        this.#log(`${m.copy}: run ${name} without a device origin (init, render or timer) acts on no device; ignored`);
      }
      return;
    }
    const d = origin.connected ? this.#devices.get(origin.session) : undefined;
    if (!d) return this.#log(`${m.copy}: run ${name} for session ${origin.session}, which is not open; ignored`);
    const own = isObject(args) ? args : undefined;
    if (this.#isResize(name, own) && !this.#admitLayout(d)) return;
    const out = d.session.run(name, own, this.#runContext());
    this.#outcome(d, out, origin, (ok, error, message) => {
      if (ok) return;
      this.#log(`${m.copy}: run ${name} refused: ${error ?? "refused"}${message ? ` (${message})` : ""}`);
      this.#toast(d, message ?? error ?? "refused");
    });
  }

  #openOverlay(h: HostRef, m: Emit, origin: ResolvedOrigin | null): void {
    const [id, raw] = m.args;
    if (typeof id !== "string" || !hostOverlayIdOk(id, h.folder)) {
      return this.#log(`forged-overlay-ignored folder=${h.folder} id=${JSON.stringify(id)}`);
    }
    if (this.#overlays.has(id)) return;
    const devices = this.#recipients(origin);
    const spec = parseOverlaySpec(raw ?? null, (mod) => this.#data.overlayFor?.(mod) ?? "device");
    if (typeof spec === "string") {
      this.#log(`${m.copy}: openOverlay refused: ${spec}`);
      if (origin !== null) { for (const d of devices) this.#toast(d, spec); }
      return;
    }
    if (devices.length === 0) return this.#log(`${m.copy}: openOverlay ${id} with no device to show it; ignored`);
    if (spec.key !== undefined) {
      for (const o of [...this.#overlays.values()]) {
        if (o.spec.key === spec.key && o.spec.mod === spec.mod) this.#destroyOverlay(o);
      }
    }
    this.#createOverlay(id, spec, devices, false);
  }

  #notify(m: Emit, origin: ResolvedOrigin | null): void {
    const n = m.args[1];
    if (!isObject(n)) return;
    const toast: Toast = { t: "toast", title: typeof n.title === "string" ? n.title : "" };
    if (typeof n.body === "string" && n.body !== "") toast.body = n.body;
    if (typeof n.level === "string" && Object.hasOwn(TOAST_LEVELS, n.level)) toast.level = TOAST_LEVELS[n.level];
    const action = n.action;
    if (isObject(action) && typeof action.name === "string" && action.name !== "") {
      toast.action = isObject(action.args) ? { name: action.name, args: action.args } : { name: action.name };
    }
    if (!is(ToastSchema, toast)) return this.#log(`${m.copy}: notify with an unusable notification`);
    for (const d of this.#recipients(origin)) d.conn?.send(toast);
  }

  /**
   * `write_to_clipboard(text)`: offered to the device of the call's origin, without an origin to the lead's (a browser
   * writes the clipboard only in a user gesture: the client shows it for copying). Never kept for a resume.
   */
  #clipboard(m: Emit, origin: ResolvedOrigin | null): void {
    const text = m.args[0];
    if (typeof text !== "string") return this.#log(`${m.copy}: write_to_clipboard without text; ignored`);
    const d = origin === null ? this.#lead : origin.connected ? this.#devices.get(origin.session) : undefined;
    if (!d?.conn) return this.#log(`${m.copy}: write_to_clipboard with no connected device; dropped`);
    d.conn.send({ t: "clipboard", text });
  }

  /**
   * `playSound(path)`: played on the device whose event or command led to the call, and on no other — a call without
   * an origin (init, render, a timer) or with a downgraded one plays nowhere. The file and the per-session rate are
   * {@link HerdrData.sound}'s. Never kept for a resume (a late sound means nothing).
   */
  #sound(h: HostRef, m: Emit, origin: ResolvedOrigin | null): void {
    if (origin === null || !origin.connected) {
      if (!this.#soundNoted.has(h.folder)) {
        this.#soundNoted.add(h.folder);
        this.#log(`${m.copy}: playSound without a device origin plays on no device; dropped`);
      }
      return;
    }
    const session = origin.session;
    if (!this.#data.sound || !this.#devices.get(session)?.conn) return;
    this.#data.sound(h, m.args[0], origin).then(
      (src) => {
        if (src !== null) this.#devices.get(session)?.conn?.send({ t: "sound", src });
      },
      (e) => this.#log(`${m.copy}: playSound failed: ${messageOf(e)}`),
    );
  }

  /** `look()` may have changed: every device holding another look gets `look` (a detached one gets it in `hello`). */
  #sendLook(): void {
    const look = this.#data.look();
    for (const d of this.#devices.values()) {
      if (d.look === look) continue;
      const changed = !jsonEqual(asJson(d.look), asJson(look));
      d.look = look;
      if (changed) d.conn?.send({ t: "look", theme: look.theme, settings: look.settings, fonts: look.fonts });
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Flush.

  #schedule(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flush();
    }, this.#flushMs);
  }

  #flush(): void {
    if (this.#lookDue) {
      this.#lookDue = false;
      this.#sendLook();
    }
    for (const v of this.#views.values()) {
      if (!v.dirty || v.tree === null) continue;
      v.dirty = false;
      if (v.reset || v.flushed === null) {
        v.ops = null;
        v.reset = false;
      } else {
        const ops = diffJson(asJson(v.flushed), asJson(v.tree));
        if (ops.length === 0) {
          v.flushed = v.tree;
          continue;
        }
        v.ops = ops;
      }
      v.flushed = v.tree;
      v.version++;
    }
    for (const d of this.#devices.values()) this.#flushDevice(d);
  }

  #flushDevice(d: Device): void {
    const views: Patch["views"] = [];
    for (const copy of d.shown) {
      const v = this.#views.get(copy);
      if (!v || v.flushed === null) continue;
      const sent = d.sent.get(copy);
      if (sent === v.version) continue;
      d.sent.set(copy, v.version);
      if (sent === v.version - 1 && v.ops !== null) views.push({ view: copy, ops: v.ops });
      else this.#post(d, { t: "view.tree", view: copy, tree: v.flushed });
    }
    let state: JsonPatch | undefined;
    if (d.state) {
      d.state = false;
      const next = this.#snapshotFor(d.id, d.session);
      const ops = diffJson(asJson(d.snapshot), asJson(next));
      d.snapshot = next;
      if (ops.length > 0) state = ops;
    }
    const screens = d.screens;
    d.screens = false;
    if (views.length === 0 && state === undefined && !screens) return;
    const patch: Patch = { t: "patch", seq: ++d.seq, views };
    if (state !== undefined) patch.state = state;
    if (screens) patch.screens = d.session.graph;
    this.#post(d, patch);
  }
}
