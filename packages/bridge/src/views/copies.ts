/**
 * Which mod copies exist (DESIGN-v2 §1.7, AGENTS.md "A copy starts the first time it shows, then stays alive while its
 * block is in the layout, shown or not"):
 *
 * - block copies `<folder>:<blockId>`: every mod block and floating entry of the Mac's layout is a candidate
 *   ({@link layoutBlocks}); a candidate starts once some session shows it and stays while the layout keeps it with
 *   the same props;
 * - pane header copies `<folder>:pane:<paneId>`: one per pane of the tab a session shows under a `panes` screen with a
 *   `header`, props `{...header.props, pane, terminal}`; they stay while the pane exists;
 * - overlay copies `<folder>:overlay:<id>` (the view manager's overlays).
 *
 * What a session shows ({@link shownCopies}): the screens of the routes on its navigator stack and its sheets — every
 * split/bar child, only a group's active mounted destination; links show nothing by themselves (their route does when
 * it is on the stack).
 */

import {
  FOLDER_PATTERN,
  type JsonObject,
  type LayoutNode,
  type PaneInfo,
  parseCopyId,
  type Placement,
  type ScreenGraph,
  type ScreenNode,
} from "@herdr-relay/protocol";

/** What a copy is created with. */
export interface CopySpec {
  props: JsonObject;
  placement: Placement | null;
}

const FOLDER = new RegExp(FOLDER_PATTERN, "u");
const EDGES = ["top", "right", "bottom", "left"] as const;
const ALIGNS = ["start", "center", "end"] as const;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** The mod folder of a layout `content`, or null (agent/terminal/pane content, malformed names). */
function modOf(content: unknown): string | null {
  if (!isObject(content) || typeof content.mod !== "string" || !FOLDER.test(content.mod)) return null;
  return content.mod;
}

/** Same id rule as `recompose()`: a node without an id is `#<path>` (stable while the file is unchanged). */
function idOf(n: LayoutNode, path: string): string {
  return typeof n.id === "string" && n.id !== "" ? n.id : `#${path}`;
}

/** Same block rule as `recompose()`: a typed block, or an untyped node with content or without children. */
function isBlock(n: LayoutNode): boolean {
  if (n.type === "block") return true;
  if (n.type === "row" || n.type === "column" || n.type === "stack") return false;
  return n.content !== undefined || !n.children;
}

/** `placement()` of a floating entry as laid out (never hovered or dragged on a device). */
export function floatingPlacement(f: LayoutNode): Placement {
  const edge = EDGES.find((e) => e === f.edge) ?? "bottom";
  return {
    edge,
    align: ALIGNS.find((a) => a === f.align) ?? "center",
    vertical: edge === "left" || edge === "right",
    hovered: false,
    dragging: false,
  };
}

/** Every mod block and floating entry of a layout tree, by copy id, with its props (and placement when floating). */
export function layoutBlocks(tree: LayoutNode): Map<string, CopySpec> {
  const out = new Map<string, CopySpec>();
  const add = (n: LayoutNode, id: string, placement: Placement | null) => {
    const mod = modOf(n.content);
    if (mod === null) return;
    const copy = `${mod}:${id}`;
    const ref = parseCopyId(copy);
    if (ref === null || ref.kind !== "block" || out.has(copy)) return;
    const props = (n.content as JsonObject).props;
    out.set(copy, { props: isObject(props) ? props : {}, placement });
  };
  const visit = (n: LayoutNode, path: string) => {
    (n.floating ?? []).forEach((f, i) => {
      const fpath = `${path}.f${i}`;
      add(f, idOf(f, fpath), floatingPlacement(f));
    });
    if (isBlock(n)) return add(n, idOf(n, path), null);
    (n.children ?? []).forEach((c, i) => visit(c, `${path}.${i}`));
  };
  visit(tree, "r");
  return out;
}

/** Pane header copy id. */
export function paneCopy(folder: string, pane: string): string {
  return `${folder}:pane:${pane}`;
}

/** Folders drawn as pane headers by the layout's `{tab: "active", pane: {header: {content: {mod}}}}` blocks. */
export function paneHeaderFolders(tree: LayoutNode): Set<string> {
  const out = new Set<string>();
  const visit = (n: LayoutNode) => {
    const c = n.content;
    if (isObject(c) && c.tab === "active" && isObject(c.pane) && isObject(c.pane.header)) {
      const mod = modOf(c.pane.header.content);
      if (mod !== null) out.add(mod);
    }
    for (const k of n.children ?? []) visit(k);
    for (const f of n.floating ?? []) visit(f);
  };
  visit(tree);
  return out;
}

/** The copies a session shows now. */
export interface Shown {
  /** Block copy ids on screen. */
  blocks: Set<string>;
  /** Pane header copies on screen, with their specs. */
  panes: Map<string, CopySpec>;
}

/**
 * The copies on a session's screen: the routes on its stack and its sheets. `panes` are the panes of the tab the
 * session shows (they fill every `panes` screen).
 */
export function shownCopies(graph: ScreenGraph, panes: readonly PaneInfo[]): Shown {
  const shown: Shown = { blocks: new Set(), panes: new Map() };
  const visit = (node: ScreenNode) => {
    switch (node.kind) {
      case "split":
      case "bar":
        for (const c of node.children) visit(c);
        return;
      case "group": {
        const d = node.destinations.find((x) => x.id === node.active);
        if (d?.mounted) visit(d.screen);
        return;
      }
      case "block": {
        const ref = parseCopyId(node.view);
        if (ref !== null && ref.kind === "block" && FOLDER.test(ref.folder)) shown.blocks.add(node.view);
        return;
      }
      case "panes": {
        const h = node.header;
        if (!h || !FOLDER.test(h.folder)) return;
        for (const p of panes) {
          shown.panes.set(paneCopy(h.folder, p.pane), {
            props: { ...h.props, pane: p.pane, terminal: p.terminal },
            placement: null,
          });
        }
        return;
      }
      case "terminal":
      case "link":
        return;
    }
  };
  for (const path of graph.stack) {
    const route = graph.routes.find((r) => r.path === path);
    if (route) visit(route.screen);
  }
  for (const s of graph.sheets) visit(s.screen);
  return shown;
}
