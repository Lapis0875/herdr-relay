/**
 * A view's element tree on screen. `ViewRenderer` is what the shell's view slots draw (`app/slots.tsx`): the tree once
 * the bridge sent it (the slot's placeholder until then), with handler invocations going to the bridge unless the data
 * is stale, and key events only from an `act` device. `TreeView` is the same without the bridge (any sink).
 */

import { Component, type ReactElement, type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import type { ElementNode } from "@herdr-relay/protocol";
import { bridge } from "../app/client.ts";
import { ViewPlaceholder, type ViewRendererProps } from "../app/slots.tsx";
import { type EventSink, RenderContext, type RenderEnv } from "./context.ts";
import { Node } from "./node.tsx";

interface BoundaryProps {
  tree: ElementNode;
  children: ReactNode;
}

interface BoundaryState {
  tree: ElementNode | null;
  error: string | null;
}

/** A render failure shows in the view's frame instead of taking the screen down; the next tree retries. */
class Boundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { tree: null, error: null };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.tree === state.tree ? null : { tree: props.tree, error: null };
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="r-error" title={this.state.error}>
        <span className="r-error__title">This view can’t be drawn on this device</span>
        <span className="r-error__reason">{this.state.error}</span>
      </div>
    );
  }
}

export interface TreeViewProps {
  view: string;
  tree: ElementNode;
  /** Where handler invocations go; `null` sends nothing. */
  send: EventSink | null;
  /** Key events may be sent. */
  typing: boolean;
  stale?: boolean;
}

export function TreeView({ view, tree, send, typing, stale = false }: TreeViewProps): ReactElement {
  const nested = useContext(RenderContext).view !== "";
  const overlay = view.includes(":overlay:");
  const env = useMemo<RenderEnv>(() => ({ view, send, typing, overlay }), [view, send, typing, overlay]);
  const root = useRef<HTMLDivElement>(null);

  // A mod focuses its overlay's handle when it opens it (`handle.focus()`, which stays on the Mac): the overlay's
  // focus target takes this device's keyboard instead, unless focus already moved inside.
  useEffect(() => {
    if (!overlay) return;
    const frame = requestAnimationFrame(() => {
      const el = root.current;
      if (!el || el.contains(document.activeElement)) return;
      el.querySelector<HTMLElement>("[data-track-focus]")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [overlay]);

  return (
    <div
      ref={root}
      className={nested ? "r-view r-view--nested" : "r-view"}
      data-view={view}
      data-stale={stale ? "" : undefined}
    >
      <RenderContext.Provider value={env}>
        <Boundary tree={tree}>
          <Node node={tree} />
        </Boundary>
      </RenderContext.Provider>
    </div>
  );
}

/** The shell's view renderer (`provideViewRenderer`). */
export function ViewRenderer(props: ViewRendererProps): ReactElement {
  const { view, tree, stale, scope } = props;
  const send = useMemo<EventSink>(() => (handler, kind, data) => void bridge.event(view, handler, kind, data), [view]);
  if (tree === undefined) return <ViewPlaceholder {...props} />;
  return <TreeView view={view} tree={tree} send={stale ? null : send} typing={scope === "act"} stale={stale} />;
}
