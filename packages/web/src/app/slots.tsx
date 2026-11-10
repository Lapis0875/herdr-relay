/**
 * The stable seam between the shell (T15) and the renderers. The navigator never draws mod content itself; every
 * block, bar, pane header, overlay and nested `k:"view"` node calls `renderView(viewId)`, and every terminal screen
 * (and `k:"terminal"` node) calls `renderTerminal(...)`. Without a provided renderer they draw a labelled placeholder.
 *
 * - T16 (`src/render/mod.tsx`) calls `provideViewRenderer(ViewRenderer)`: the component receives the view's current
 *   `ElementTree` (reference-stable between patches that do not touch it), the stale flag, its mod host's state and
 *   the device scope, and sends handler invocations with `bridge.event(view, handler, kind, data)` (`client.ts`).
 *   Until a view's first `view.tree` arrives it draws `ViewPlaceholder`.
 * - T17 (`src/widgets/**`) calls `provideTerminalRenderer(Component)`.
 * Both must be called before `boot()` renders (`src/main.tsx` imports the modules for their side effect).
 */

import { type ComponentType, memo, type ReactElement, useMemo } from "react";
import type { ElementNode, HostStatus, Scope, TermSize } from "@herdr-relay/protocol";
import { useApp } from "./store.ts";

export interface ViewRendererProps {
  /** `<folder>:<blockId>`, `<folder>:pane:<paneId>` or an overlay's view. */
  view: string;
  /** The view's tree; `undefined` until the bridge sent its `view.tree`. */
  tree: ElementNode | undefined;
  /** The data is not live (offline, reconnecting or from the cache): show it, do not send events. */
  stale: boolean;
  /** The mod host of the view's folder (`hello.hosts`), if the bridge reported it. */
  host: HostStatus | undefined;
  scope: Scope | undefined;
}

export interface TerminalRendererProps {
  /** The screen node id. */
  id: string;
  /** The core terminal address to show (an `agent:"focused"` screen resolves to the session's focused agent). */
  terminal: string | null;
  /** `focused`: follows the session's focused agent (R7). */
  agent?: "focused";
  /** The Mac's geometry once `term.size` arrived (D4: never resized remotely). */
  size: TermSize | undefined;
  stale: boolean;
  scope: Scope | undefined;
}

let viewRenderer: ComponentType<ViewRendererProps> | null = null;
let terminalRenderer: ComponentType<TerminalRendererProps> | null = null;

/** Installs the element-tree renderer (T16). */
export function provideViewRenderer(component: ComponentType<ViewRendererProps>): void {
  viewRenderer = component;
}

/** Installs the terminal widget (T17). */
export function provideTerminalRenderer(component: ComponentType<TerminalRendererProps>): void {
  terminalRenderer = component;
}

/** The folder a view id belongs to (`files:files` → `files`). */
export function folderOf(view: string): string {
  const i = view.indexOf(":");
  return i > 0 ? view.slice(0, i) : view;
}

const ViewSlot = memo(function ViewSlot({ view }: { view: string }) {
  const tree = useApp((s) => s.views[view]);
  const stale = useApp((s) => s.stale !== null || s.conn.kind !== "live");
  const hosts = useApp((s) => s.hello?.hosts);
  const scope = useApp((s) => s.hello?.scope);
  const folder = folderOf(view);
  const host = useMemo(() => hosts?.find((h) => h.folder === folder), [hosts, folder]);
  const Renderer = viewRenderer ?? ViewPlaceholder;
  return <Renderer view={view} tree={tree} stale={stale} host={host} scope={scope} />;
});

/** The content of a mod view slot. Stable entry point for nested views too (T16's `k:"view"` nodes). */
export function renderView(viewId: string): ReactElement {
  return <ViewSlot key={viewId} view={viewId} />;
}

const TerminalSlot = memo(function TerminalSlot(
  { id, terminal, agent }: { id: string; terminal?: string; agent?: "focused" },
) {
  const focusedAgent = useApp((s) => s.live?.focused?.agent ?? null);
  const address = terminal ?? (agent === "focused" ? focusedAgent : null);
  const size = useApp((s) => (address ? s.terms[address] : undefined));
  const stale = useApp((s) => s.stale !== null || s.conn.kind !== "live");
  const scope = useApp((s) => s.hello?.scope);
  const Renderer = terminalRenderer ?? TerminalPlaceholder;
  return <Renderer id={id} terminal={address} agent={agent} size={size} stale={stale} scope={scope} />;
});

/** A terminal screen (R7 `agent:"focused"`, a `{terminal}` block, a peek sheet, a pane body). */
export function renderTerminal(o: { id: string; terminal?: string; agent?: "focused" }): ReactElement {
  return <TerminalSlot key={o.id} id={o.id} terminal={o.terminal} agent={o.agent} />;
}

const HOST_TEXT: Record<string, string> = {
  starting: "mod host starting…",
  restarting: "mod host restarting…",
  failed: "mod host failed",
  stopped: "mod host stopped",
};

/** A view slot without a tree: which view goes here and why nothing is drawn yet (its host's state, or waiting). */
export function ViewPlaceholder({ view, host }: ViewRendererProps): ReactElement {
  const hostText = host && host.state !== "running" ? `${HOST_TEXT[host.state] ?? host.state}` : null;
  const status = hostText ?? "waiting for first render…";
  return (
    <div
      className="slot-placeholder"
      data-view={view}
      data-state={hostText ? "host" : "empty"}
      role="img"
      aria-label={`Mod view ${view}, ${status}`}
    >
      <span className="slot-placeholder__label" translate="no">{view}</span>
      <span className="slot-placeholder__status">
        {status}
        {hostText && host?.reason ? ` — ${host.reason}` : null}
      </span>
    </div>
  );
}

/** A terminal screen when no terminal renderer is installed (outside the app: tests, server rendering). */
export function TerminalPlaceholder({ id, terminal, agent, size, stale }: TerminalRendererProps): ReactElement {
  const what = terminal ?? (agent === "focused" ? "no focused agent" : "no terminal");
  const geometry = size ? `${size.cols}×${size.rows}` : "size pending";
  return (
    <div
      className="slot-placeholder slot-placeholder--terminal"
      data-terminal={terminal ?? ""}
      role="img"
      aria-label={`Terminal ${what} (widget pending)`}
    >
      <span className="slot-placeholder__label" translate="no">
        {agent === "focused" ? "agent · " : "terminal · "}
        {what}
      </span>
      <span className="slot-placeholder__status">{`${id} · ${geometry}${stale ? " · stale" : ""}`}</span>
    </div>
  );
}
