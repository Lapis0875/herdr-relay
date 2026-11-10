/**
 * What the view manager needs from the `herdr` implementation (DESIGN-v2 §4 T09, DESIGN.md §5.4): the Mac's live data,
 * the layout it shows, and the handling of every mod call that is not a view's own. T09 implements {@link HerdrData};
 * the view manager owns sessions, copies, trees, handler ids, overlays, toasts and `run()` routing.
 *
 * Division of work for host → bridge messages:
 * - view manager: `tree`, `event-result`, `error`, and the emits `run` (§2.4 classes via the session), `openOverlay`,
 *   `closeOverlay`, `notify` (→ `toast`), `write_to_clipboard` (→ `clipboard`), `playSound` (→ `sound`, the file
 *   checked by {@link HerdrData.sound}), `focus` (no device message exists; dropped);
 * - {@link HerdrData.emit}: `setShared` (D8 overlay), `setAgentOrder`, `net.close`;
 * - {@link HerdrData.rpc}: every RPC except `storage.set` (answered by the host supervisor);
 * - {@link HerdrData.passthrough}: `run()`/`command` names of the `passthrough` class (E9, `herdr-app do`).
 *
 * Origins: hosts only ever hold opaque origin tokens (`./origins.ts`); the view manager maps a message's token to the
 * device session before T09 sees it ({@link ResolvedOrigin}). A token that does not name a session for that folder's
 * current host (forged, raw session id, expired, another folder's, an earlier host's) resolves to `scope: "read"`,
 * `connected: false`.
 */

import type {
  ClickState,
  CommandInfo,
  Emit,
  Fonts,
  HelloCompat,
  HostState,
  JsonObject,
  JsonValue,
  NamedLayout,
  Rpc,
  Scope,
  Snapshot,
} from "@herdr-relay/protocol";
import type { HostRef } from "../hosts/mod.ts";
import type { SessionWorld } from "../session/mod.ts";
import type { OverlayPlacement } from "./overlays.ts";

/** The device session a host call came from, as the bridge's own session table knows it. */
export interface ResolvedOrigin {
  /** The session id; for a downgraded origin, the token the host presented (it names no session). */
  session: string;
  /** The session's device scope; `read` when the origin was downgraded or the session is gone. */
  scope: Scope;
  /** False when the origin named no open session (downgraded: forged, expired, foreign or stale token). */
  connected: boolean;
}

/** `snapshot` without its envelope: what one session's device holds outside view trees. */
export type SnapshotState = Omit<Snapshot, "t" | "seq">;

/** The Mac's shown layout and its saved clicks (`layouts/<name>.json`, `layouts/.state/<name>.json`). */
export interface MacLayout {
  layout: NamedLayout;
  clicks: ClickState | null;
}

/** What changed in {@link HerdrData}; the view manager re-reads the affected parts. */
export type HerdrChange =
  /** `layout()` changed: the file, its clicks, or another layout is shown on the Mac. */
  | { kind: "layout" }
  /** Anything `hostState`, `world`, `commands`, `look` or `snapshot` return changed. */
  | { kind: "state" }
  /**
   * One shared key changed (fast path to the hosts). `session` is the D8 overlay it was set in (a session id), or
   * `null` for `shared.json` itself. `hostState`/`snapshot` must already return the new value.
   */
  | { kind: "shared"; key: string; value: JsonValue; session: string | null };

/** The look a device gets in the bridge `hello`. */
export interface ClientLook {
  /** Theme colour name → `#rrggbb[aa]` (`theme()`). */
  theme: Record<string, string>;
  /** `settings()`. */
  settings: JsonObject;
  /** CSS font-family lists for the client (D10). */
  fonts: Fonts;
}

/**
 * The `herdr` data and effects provider. Every method may be called often (each host `state` push, each flush) and
 * must be cheap; the returned objects are not mutated by the view manager.
 */
export interface HerdrData {
  /** The Mac's shown layout and clicks; sessions start from them and follow their changes. */
  layout(): MacLayout;
  /** The Mac's live spaces/panes/agents/focus for session focus commands (`agent.focus`, `pane.focus`, …). */
  world(): SessionWorld;
  /** Herdr's `commands()`: resolves the keys.json `name:value` shorthand of `run()` and `command`. */
  commands(): readonly CommandInfo[];
  /**
   * The full `HostState` of one mod folder. `lead` is the session whose view the hosts render (the device that acted
   * last; `null` without sessions): its D8 `shared` overlay applies. The view manager replaces `layout`, `focused`,
   * `spaces`, `panes` and `agents` with that session's own before the state reaches a host, so return the Mac's (clicks
   * applied) there.
   */
  hostState(folder: string, lead: string | null): HostState;
  /** The bridge `hello` look fields. */
  look(): ClientLook;
  /**
   * One session's snapshot (its D8 `shared` overlay applied); the view manager replaces `focused`, `spaces`, `panes`
   * and `agents` with the session's.
   */
  snapshot(session: string): SnapshotState;
  /** Registers a change listener; returns the unsubscribe function. */
  subscribe(listener: (change: HerdrChange) => void): () => void;
  /** A host emit the view manager does not handle (`setShared`, `setAgentOrder`, `net.close`). */
  emit(host: HostRef, msg: Emit, origin: ResolvedOrigin | null): void;
  /** A host RPC (all but `storage.set`): its value (`undefined` = none), or a rejection whose message the mod sees. */
  rpc(host: HostRef, msg: Rpc, origin: ResolvedOrigin | null): Promise<JsonValue | undefined>;
  /**
   * Runs a `passthrough` command (E9, `herdr-app do <name> <json>`) for an `act` session; the view manager has already
   * classified the name and checked the scope. Rejects with a device-safe message when it fails.
   */
  passthrough(name: string, args: JsonObject, origin: ResolvedOrigin): Promise<void>;
  /** A session ended: drop what is kept for it (its D8 overlay). */
  sessionClosed(session: string): void;
  /** Where `mod`'s overlays may open (its policy profile's `overlay`); absent: every mod opens on devices. */
  overlayFor?(mod: string): OverlayPlacement;
  /** `hello.compat`: the running Herdr against the contract pins (OSS-PLAN §2.3); absent: `hello` goes without it. */
  compat?(): HelloCompat | undefined;
  /**
   * A mod's `playSound(path)` from a connected device session: the `sound.src` to send that device (the file passed
   * the asset policy and the session is under its sound rate), or null (refused and logged, or over the rate). Absent:
   * sounds are dropped.
   */
  sound?(host: HostRef, path: JsonValue | undefined, origin: ResolvedOrigin): Promise<string | null>;
}
