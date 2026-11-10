/**
 * `recompose(layout, clickState, device) → ScreenGraph` (DESIGN.md §3): turns a Herdr layout plus its saved clicks into
 * the routes, bars, screen groups, pane groups and sheets of one device class. Pure; used by the bridge (copies to
 * instantiate, session navigation) and by the client (navigation). Rules read node structure, never ids:
 *
 * - R1 bar: a block/row/column with fixed `size.px` ≤ 72 along its parent row/column's axis and no `min`/`max` (a
 *   resizable node is a panel at any size: a sidebar dragged to a 44 px rail stays a panel); kept in place. A bar's
 *   content is not reclassified (rules apply top-down).
 * - R2 panel: in a row, a non-bar child with fixed `px` (or `min`/`max` without a `weight`); the weighted/unsized child
 *   is main. Panels before the main are leading (left), after it trailing (right).
 * - R3 stack → screen group; R4 floating → sheet; R5 hidden → exists, not mounted; R6 `{tab:"active"}` → pane group;
 *   R7 `{agent:"focused"}` → terminal screen.
 *
 * Phone: the root row's main is route `/`; the root row's first leading panel is the `/drawer` route; every other
 * panel (and every extra unsized row child) is a `push` route, reached inside its row through a `link` left in its
 * place; a row that lost children to routes turns into a column; a row holding one stack plus bars makes those bars
 * the stack's switcher (the layout draws the segment row, `nav:"tabs"`), as lstack's activity rail does for
 * `panel-body`; stacks of more than 5 get 4 segments plus "More"; pane groups page one pane at a time; sheets sit at
 * the bottom with a 44 px handle when they peek; single-child splits collapse into their child.
 * Tablet-landscape and desktop: the layout as drawn (a touch tablet resizes too; a `resizable: false` parent keeps its
 * children fixed). Tablet-portrait: leading panels collapse to their `min` (rail), trailing panels become `sheet` routes
 * from the right. On every class but phone, exactly the split children `overridable()` names carry `resize` (`kind`,
 * `collapsible`: what a client `layout set` may change) and their resize bounds (`size.min`/`max`, where the layout
 * has them); other nodes carry neither. Every R2 panel drawn as its rail carries `collapsed: true`, every expanded
 * collapsible one `collapsed: false` (on any node kind: a block at its `min` and its rail have the same size).
 *
 * Device layout profile: `applyProfile(tree, section, device)` applies one device's saved sizes for this layout and
 * class (`px` clamped to the node's `min`/`max`, `weight`, `collapsed` on R2 panels) to the effective tree, after the
 * Mac's file and clicks and before session-transient clicks; `profiledNodes()` names the nodes it changes
 * (`ScreenGraph.overridden`). Only `overridable()` nodes take an entry; any other id is ignored, never an error.
 * `collapsed` is carried on the tree node (a relay field Herdr files do not have): `true` draws an R2 panel as its rail
 * on any tablet/desktop class, `false` keeps a tablet-portrait leading panel expanded.
 *
 * Inputs are trusted shapes: validate layout files with `LayoutNodeSchema`, `.state` files with `ClickStateSchema` and
 * profile sections with `LayoutProfileSectionSchema` where they are read.
 */

import { type LayoutNode, LayoutNodeSchema } from "./herdr.ts";
import {
  boolean,
  define,
  enumOf,
  is,
  type JsonObject,
  jsonObjectRef,
  number,
  object,
  openObject,
  record,
  type Static,
  string,
} from "./schema.ts";
import {
  BAR_MAX_PX,
  type DeviceClass,
  type GroupScreen,
  PEEK_HANDLE_PX,
  type RecomposeRule,
  type ScreenDestination,
  type ScreenGraph,
  type ScreenNode,
  type ScreenResize,
  type ScreenRoute,
  type ScreenSheet,
  type ScreenSize,
  SEGMENTS_MAX,
  SEGMENTS_WITH_MORE,
} from "./screens.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Inputs.

/** One node's saved clicks in `layouts/.state/<name>.json` (`hidden`, stack `active`, `size`, look fields…). */
export const NodeClicksSchema = define("NodeClicks", () =>
  openObject({}, {
    hidden: boolean(),
    active: string(),
    size: openObject({}, { px: number(), weight: number() }),
  }));
export type NodeClicks = Static<typeof NodeClicksSchema>;

/** `layouts/.state/<name>.json`: clicks per node id, and the layout file as it was when they were saved. */
export const ClickStateSchema = define(
  "ClickState",
  () => openObject({}, { nodes: record(NodeClicksSchema), file: LayoutNodeSchema }),
);
export type ClickState = Static<typeof ClickStateSchema>;

/**
 * One node's entry in a device's layout profile: its saved `px` (fixed size, clamped to the node's `min`/`max` when
 * applied) or `weight` (share among its weighted siblings), and `collapsed` (R2 panels: drawn as the rail).
 */
export const NodeProfileSchema = define("NodeProfile", () =>
  object({}, {
    px: number({ minimum: 0 }),
    weight: number({ minimum: 0 }),
    collapsed: boolean(),
  }));
export type NodeProfile = Static<typeof NodeProfileSchema>;

/** One device's profile for one layout and device class: entries by layout node id. */
export const LayoutProfileSectionSchema = define("LayoutProfileSection", () => record(NodeProfileSchema));
export type LayoutProfileSection = Static<typeof LayoutProfileSectionSchema>;

/** A layout by name, as `hello.layout` carries it. */
export interface NamedLayout {
  name: string;
  tree: LayoutNode;
}

/** The home route. */
export const HOME_ROUTE = "/";
/** The route of the root row's first leading panel on a phone. */
export const DRAWER_ROUTE = "/drawer";
/** Header height of a pane group whose header leaves it unset (Herdr does not publish its default; [I]). */
export const PANE_HEADER_DEFAULT_PX = 30;

/** Keys a click never changes (structure). */
const STRUCTURE_KEYS: Record<string, true> = { id: true, type: true, children: true, floating: true };

/** The part of a `{tab:"active"}` block's `pane` options recompose reads: the header copy. */
const PaneOptionsSchema = openObject({}, {
  header: openObject({ content: openObject({ mod: string({ minLength: 1 }) }, { props: jsonObjectRef }) }, {
    height: number({ minimum: 0 }),
    position: enumOf(["top", "bottom"]),
  }),
});

/**
 * The layout as Herdr shows it: a copy of `tree` with every click of `clicks.nodes` applied (shallow, per field). Click
 * ids the tree does not have are ignored; structure keys are never clicked; and a deliberate layout-file edit beats a
 * click on that field: when `clicks.file` (the file at click time) has the node and its value for the field differs
 * from the current file's, the file wins. Without `clicks.file` every click applies (session overlays use that).
 */
export function applyClicks(tree: LayoutNode, clicks: ClickState | null | undefined): LayoutNode {
  const out = structuredClone(tree);
  const nodes = clicks?.nodes;
  if (!nodes) return out;
  const before = clicks.file ? indexById(clicks.file) : null;
  for (const node of walk(out)) {
    const id = node.id;
    if (typeof id !== "string" || !Object.hasOwn(nodes, id)) continue;
    const then = before?.get(id);
    for (const [key, value] of Object.entries(nodes[id])) {
      if (Object.hasOwn(STRUCTURE_KEYS, key) || value === undefined) continue;
      if (then && !jsonEqual(then[key], node[key])) continue;
      node[key] = structuredClone(value);
    }
  }
  return out;
}

/** `recompose()` with the clicks applied first (DESIGN.md §3 signature). */
export function recompose(layout: NamedLayout, clickState: ClickState | null, device: DeviceClass): ScreenGraph {
  return recomposeTree(layout.name, applyClicks(layout.tree, clickState), device);
}

/** Recomposes an already effective tree (clicks, profile and session overlays applied). */
export function recomposeTree(name: string, tree: LayoutNode, device: DeviceClass): ScreenGraph {
  const b = new Builder(device, tree);
  const home = device === "phone" ? b.phoneRoot(tree) : b.fullRoot(tree);
  const graph: ScreenGraph = {
    v: 1,
    layout: name,
    class: device,
    routes: [home, ...b.routes],
    sheets: b.sheets(tree),
    stack: [HOME_ROUTE],
  };
  graph.stack = initialStack(graph);
  return graph;
}

// ---------------------------------------------------------------------------------------------------------------------
// Device layout profile.

/** How a node a device may resize (`overridable()`) takes its size. */
export interface OverridableNode {
  /** The parent split's axis the size runs along: `row` → width, `column` → height. */
  axis: "row" | "column";
  /** `px`: a fixed size (the node has `size.px`, or only `min`/`max`); `weight`: a share among weighted siblings. */
  kind: "px" | "weight";
  /** Resize bounds from the layout file, in px. */
  min?: number;
  max?: number;
  /** An R2 panel (row child): takes `collapsed`; its rail is `min ?? PEEK_HANDLE_PX` px. */
  collapsible: boolean;
}

/**
 * The nodes a device of class `device` may resize, by id, derived from the layout contract (never from ids): a child
 * of a row/column whose `resizable` is not `false`, with `size.px`, `size.weight`, `min` or `max`; not an R1 bar and not
 * inside one (a bar's content is kept as drawn); with a layout id (a synthetic `#path` id would retarget after a file
 * edit); next to at least one other non-bar child in the split on this class (tablet-portrait: trailing panels are
 * sheets, not split children). `hidden` does not matter: it is session-transient and applied after the profile, so a
 * panel's width survives closing and reopening it. Phone: none. Of nodes sharing an id, the first in document order.
 * On tablet-landscape and desktop only these nodes carry their `min`/`max` in the ScreenGraph `size`.
 */
export function overridable(tree: LayoutNode, device: DeviceClass): Map<string, OverridableNode> {
  return new Map([...resizableSlots(tree, device)].map(([id, slot]) => [id, slot.info]));
}

/**
 * A copy of `tree` with one device's profile `section` (this layout, class `device`) applied to its `overridable()`
 * nodes; other ids are ignored. `px` applies to `px` nodes, clamped to `min`/`max` as recompose clamps `size.px` (an
 * unbounded node other than a stack keeps more than `BAR_MAX_PX`, so a profile never turns it into an R1 bar); `weight`
 * applies to `weight` nodes; `collapsed` to collapsible ones (kept on the node; recompose draws the rail). Apply it to
 * the tree with the Mac's clicks, before session-transient clicks.
 */
export function applyProfile(
  tree: LayoutNode,
  section: LayoutProfileSection | null | undefined,
  device: DeviceClass,
): LayoutNode {
  const out = structuredClone(tree);
  if (!section) return out;
  for (const [id, { node, info }] of resizableSlots(out, device)) {
    if (!Object.hasOwn(section, id)) continue;
    const e = effectOf(section[id], info);
    if (e.px !== undefined) node.size = { ...node.size, px: clampPx(node, e.px) };
    if (e.weight !== undefined) node.size = { ...node.size, weight: e.weight };
    if (e.collapsed !== undefined) node.collapsed = e.collapsed;
  }
  return out;
}

/**
 * The ids `applyProfile(tree, section, device)` changes, sorted (`ScreenGraph.overridden`): `overridable()` nodes whose
 * entry has a size of the node's kind, or a boolean `collapsed` on a collapsible one. A stale entry (an unknown or
 * ineligible id, a size of the other kind, `collapsed` on a node that cannot collapse) does not count.
 */
export function profiledNodes(
  tree: LayoutNode,
  section: LayoutProfileSection | null | undefined,
  device: DeviceClass,
): string[] {
  if (!section) return [];
  return [...resizableSlots(tree, device)]
    .filter(([id, { info }]) => Object.hasOwn(section, id) && Object.keys(effectOf(section[id], info)).length > 0)
    .map(([id]) => id)
    .sort();
}

/** What of a profile entry applies to a node: a size of its kind, `collapsed` when it is collapsible. */
function effectOf(entry: NodeProfile, info: OverridableNode): NodeProfile {
  const px = info.kind === "px" ? nonNegative(entry.px) : undefined;
  const weight = info.kind === "weight" ? nonNegative(entry.weight) : undefined;
  const collapsed = info.collapsible && typeof entry.collapsed === "boolean" ? entry.collapsed : undefined;
  return {
    ...(px !== undefined ? { px } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(collapsed !== undefined ? { collapsed } : {}),
  };
}

interface Slot {
  node: LayoutNode;
  info: OverridableNode;
}

/** `overridable()` with each node itself (first per id, document order). */
function resizableSlots(tree: LayoutNode, device: DeviceClass): Map<string, Slot> {
  const out = new Map<string, Slot>();
  if (device === "phone") return out;
  const portrait = device === "tablet-portrait";
  const visit = (n: LayoutNode, path: string) => {
    const t = typeOf(n);
    if (t === "block") return;
    if (t === "stack") {
      for (const k of kidsOf(n, path)) visit(k.node, k.path);
      return;
    }
    const parts = classify(n, t, path);
    const split = parts.filter((p) => p.role !== "bar" && !(portrait && p.role === "panel" && p.side === "right"));
    const resizable = n.resizable !== false && split.length >= 2;
    for (const p of parts) {
      if (p.role === "bar") continue;
      const info = resizable && split.includes(p) && !out.has(p.id) ? slotInfo(p, t) : undefined;
      if (info) out.set(p.id, { node: p.node, info });
      visit(p.node, p.path);
    }
  };
  visit(tree, "r");
  return out;
}

/** A split child's `OverridableNode`, or `undefined` when it has no layout id or no size to override. */
function slotInfo(p: Part, axis: Axis): OverridableNode | undefined {
  if (typeof p.node.id !== "string" || p.node.id === "") return undefined;
  const px = pxOf(p.node);
  const weight = nonNegative(p.node.size?.weight);
  const min = nonNegative(p.node.min);
  const max = nonNegative(p.node.max);
  if (px === undefined && weight === undefined && min === undefined && max === undefined) return undefined;
  return {
    axis,
    kind: px === undefined && weight !== undefined ? "weight" : "px",
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    collapsible: axis === "row" && p.role === "panel",
  };
}

/** A profile `px` for node `n`: clamped as `pxOf` clamps; an unbounded non-stack stays above `BAR_MAX_PX` (not R1). */
function clampPx(n: LayoutNode, px: number): number {
  const clamped = pxOf({ size: { px }, min: n.min, max: n.max }) ?? px;
  const bounded = (nonNegative(n.min) ?? nonNegative(n.max)) !== undefined;
  return bounded || typeOf(n) === "stack" ? clamped : Math.max(clamped, BAR_MAX_PX + 1);
}

// ---------------------------------------------------------------------------------------------------------------------
// Graph queries (bridge session navigation and the client navigator).

/** Every screen node of a screen, depth-first: split/bar children and group destinations; links are not followed. */
export function* screenNodes(node: ScreenNode): Generator<ScreenNode> {
  yield node;
  if (node.kind === "split" || node.kind === "bar") { for (const c of node.children) yield* screenNodes(c); }
  else if (node.kind === "group") { for (const d of node.destinations) yield* screenNodes(d.screen); }
}

/** The route a layout node opens as (a panel's push/sheet route, the drawer, or `/` for its root), or `undefined`. */
export function routeOfNode(graph: ScreenGraph, nodeId: string): ScreenRoute | undefined {
  return graph.routes.find((r) => r.node === nodeId && r.path !== HOME_ROUTE) ??
    (graph.routes[0]?.node === nodeId ? graph.routes[0] : undefined);
}

/** The route whose screen shows layout node `nodeId` (without following links), or `undefined`. */
export function routeContaining(graph: ScreenGraph, nodeId: string): ScreenRoute | undefined {
  return graph.routes.find((r) => r.node === nodeId || [...screenNodes(r.screen)].some((n) => n.id === nodeId));
}

/** The first route showing a screen node of `kind` (e.g. `panes`: the pane group's route), or `undefined`. */
export function routeWithKind(graph: ScreenGraph, kind: ScreenNode["kind"]): ScreenRoute | undefined {
  return graph.routes.find((r) => [...screenNodes(r.screen)].some((n) => n.kind === kind));
}

/** Route paths of the links on screen: every split/bar child, only a group's active (mounted) destination. */
export function visibleLinks(node: ScreenNode): string[] {
  switch (node.kind) {
    case "link":
      return [node.route];
    case "split":
    case "bar":
      return node.children.flatMap(visibleLinks);
    case "group": {
      const d = node.destinations.find((x) => x.id === node.active);
      return d?.mounted ? visibleLinks(d.screen) : [];
    }
    default:
      return [];
  }
}

/**
 * The navigator stack a device opens with: `/`, then every mounted push/sheet route whose link is on screen in a route
 * already on the stack, depth-first (DESIGN.md §3: a panel shown on the Mac is mounted as the top route on first open).
 * The drawer starts closed.
 */
export function initialStack(graph: ScreenGraph): string[] {
  const byPath = new Map(graph.routes.map((r) => [r.path, r]));
  const stack = [HOME_ROUTE];
  const visit = (route: ScreenRoute | undefined) => {
    if (!route) return;
    for (const path of visibleLinks(route.screen)) {
      const next = byPath.get(path);
      if (!next || !next.mounted || next.open === "drawer" || stack.includes(path)) continue;
      stack.push(path);
      visit(next);
    }
  };
  visit(byPath.get(HOME_ROUTE));
  return stack;
}

// ---------------------------------------------------------------------------------------------------------------------
// Builder.

type NodeType = "row" | "column" | "stack" | "block";
type Axis = "row" | "column";

interface Kid {
  node: LayoutNode;
  id: string;
  path: string;
}

interface Part extends Kid {
  role: "bar" | "panel" | "main";
  side?: "left" | "right";
}

/**
 * Where a node is converted: its id, synthetic path, ancestor ids (nearest first), the size its slot gives it and, for
 * an `overridable()` split child, how this device may resize it there.
 */
interface Ctx extends Slotted {
  id: string;
  path: string;
  ancestors: string[];
}

/** A screen node's place in its parent split: `size`, and `resize` when this device may change it. */
interface Slotted {
  size?: ScreenSize;
  resize?: ScreenResize;
}

class Builder {
  readonly routes: ScreenRoute[] = [];
  private readonly paths = new Set<string>([HOME_ROUTE]);

  /** The `overridable()` nodes of the tree being built. */
  private readonly resizable: Map<LayoutNode, OverridableNode>;

  constructor(readonly device: DeviceClass, tree: LayoutNode) {
    this.resizable = new Map([...resizableSlots(tree, device).values()].map((s) => [s.node, s.info]));
  }

  private get phone(): boolean {
    return this.device === "phone";
  }

  // --- phone ---------------------------------------------------------------------------------------------------------

  phoneRoot(root: LayoutNode): ScreenRoute {
    const id = idOf(root, "r");
    if (typeOf(root) !== "row") return homeRoute(id, this.convert(root, { id, path: "r", ancestors: [] }));
    const parts = classify(root, "row", "r");
    const primary = primaryMain(parts);
    const children: ScreenNode[] = [];
    let drawer = false;
    for (const p of parts) {
      const ctx = childCtx(p, [id]);
      if (p.role === "bar") {
        if (!p.node.hidden) children.push(this.bar(p, "row", ctx));
      } else if (p === primary) {
        if (!p.node.hidden) children.push(this.convert(p.node, ctx));
      } else if (p.role === "panel" && p.side === "left" && !drawer) {
        drawer = true;
        this.route(p, ctx, "drawer", { side: "left", rule: "R2", path: DRAWER_ROUTE });
      } else {
        this.route(p, ctx, "push", p.role === "panel" ? { side: p.side, rule: "R2" } : {});
      }
    }
    if (primary && children.length === 1 && children[0].kind !== "bar") return homeRoute(primary.id, children[0]);
    return homeRoute(id, { kind: "split", id, axis: "row", children });
  }

  /** A row on a phone (see the module comment). */
  private phoneRow(n: LayoutNode, ctx: Ctx): ScreenNode {
    const parts = classify(n, "row", ctx.path);
    const primary = primaryMain(parts);
    const switcher = !!primary && typeOf(primary.node) === "stack" &&
      parts.some((p) => p.role === "bar" && !p.node.hidden);
    const flip = switcher || parts.some((p) => p.role !== "bar" && p !== primary);
    const axis: Axis = flip ? "column" : "row";
    const ancestors = [ctx.id, ...ctx.ancestors];
    const children: ScreenNode[] = [];
    for (const p of parts) {
      const c = childCtx(p, ancestors, this.slotIn(p.node));
      if (p.role === "bar") {
        if (!p.node.hidden) children.push(this.bar(p, axis, c));
      } else if (p === primary) {
        if (p.node.hidden) continue;
        // A row turned column: widths are not heights; only a weight still means something.
        const size = flip ? (c.size?.weight !== undefined ? { weight: c.size.weight } : undefined) : c.size;
        children.push(switcher ? this.group(p.node, { ...c, size }, "tabs") : this.convert(p.node, { ...c, size }));
      } else {
        const panel = p.role === "panel";
        const route = this.route(p, c, "push", panel ? { side: p.side, rule: "R2" } : {});
        children.push({ kind: "link", id: p.id, route: route.path, ...(panel ? { rule: "R2" as const } : {}) });
      }
    }
    return collapse({ kind: "split", id: ctx.id, axis, ...slotOf(ctx), children });
  }

  private phoneColumn(n: LayoutNode, ctx: Ctx): ScreenNode {
    const ancestors = [ctx.id, ...ctx.ancestors];
    const children: ScreenNode[] = [];
    for (const p of classify(n, "column", ctx.path)) {
      if (p.node.hidden) continue;
      const c = childCtx(p, ancestors, this.slotIn(p.node));
      children.push(p.role === "bar" ? this.bar(p, "column", c) : this.convert(p.node, c));
    }
    return collapse({ kind: "split", id: ctx.id, axis: "column", ...slotOf(ctx), children });
  }

  // --- tablet / desktop ----------------------------------------------------------------------------------------------

  fullRoot(root: LayoutNode): ScreenRoute {
    const id = idOf(root, "r");
    return homeRoute(id, this.convert(root, { id, path: "r", ancestors: [] }));
  }

  private fullSplit(n: LayoutNode, axis: Axis, ctx: Ctx): ScreenNode {
    const ancestors = [ctx.id, ...ctx.ancestors];
    const portrait = this.device === "tablet-portrait";
    const children: ScreenNode[] = [];
    for (const p of classify(n, axis, ctx.path)) {
      const c = childCtx(p, ancestors, this.slotIn(p.node));
      if (p.role === "panel" && portrait && p.side === "right") {
        const route = this.route(p, c, "sheet", { side: "right", rule: "R2" });
        children.push({ kind: "link", id: p.id, route: route.path, rule: "R2" });
        continue;
      }
      if (p.node.hidden) continue;
      if (p.role === "bar") {
        children.push(this.bar(p, axis, c));
        continue;
      }
      const rail = p.role === "panel" && this.railed(p.node);
      // A rail keeps the panel's bounds (where it has them) so it can be dragged open again.
      const at = rail ? { ...c, size: { ...c.size, px: nonNegative(p.node.min) ?? PEEK_HANDLE_PX } } : c;
      let node = this.convert(p.node, at);
      // Any rail says so, and a collapsible panel also says when it is expanded: a block at its `min` and the same block
      // drawn as its rail have the same size.
      if ((rail || at.resize?.collapsible) && node.kind !== "bar" && node.kind !== "link") {
        node = { ...node, collapsed: rail };
      }
      // A panel's own rule (group R3, panes R6, terminal R7) is more specific than R2.
      if (p.role === "panel" && node.kind !== "link" && !node.rule) node = { ...node, rule: "R2" };
      children.push(node);
    }
    return { kind: "split", id: ctx.id, axis, ...slotOf(ctx), children };
  }

  /** An R2 panel drawn as its rail: an overridable panel's `collapsed` (profile), else the tablet-portrait default. */
  private railed(n: LayoutNode): boolean {
    if (this.resizable.has(n) && typeof n.collapsed === "boolean") return n.collapsed;
    return this.device === "tablet-portrait";
  }

  // --- shared --------------------------------------------------------------------------------------------------------

  /** Converts a node by type under this class's rules. */
  private convert(n: LayoutNode, ctx: Ctx): ScreenNode {
    switch (typeOf(n)) {
      case "block":
        return this.content(n, ctx);
      case "stack":
        return this.group(n, ctx, this.phone ? "segments" : "tabs");
      case "row":
        return this.phone ? this.phoneRow(n, ctx) : this.fullSplit(n, "row", ctx);
      case "column":
        return this.phone ? this.phoneColumn(n, ctx) : this.fullSplit(n, "column", ctx);
    }
  }

  /** R3: a stack as a screen group; `convert` false keeps destinations as drawn (inside a bar). */
  private group(n: LayoutNode, ctx: Ctx, nav: GroupScreen["nav"], convert = true): ScreenNode {
    const kids = kidsOf(n, ctx.path);
    if (kids.length === 0) return emptyBox(ctx);
    const ids = kids.map((k) => k.id);
    const ancestors = [ctx.id, ...ctx.ancestors];
    const destinations: ScreenDestination[] = kids.map((k) => {
      const at = { id: k.id, path: k.path, ancestors };
      return {
        id: k.id,
        title: titleOf(k.node, k.id, ancestors),
        mounted: !k.node.hidden,
        screen: convert ? this.convert(k.node, at) : this.plain(k.node, at),
      };
    });
    const more = nav === "segments" && ids.length > SEGMENTS_MAX;
    return {
      kind: "group",
      id: ctx.id,
      active: activeOf(n, ids),
      nav,
      shown: more ? ids.slice(0, SEGMENTS_WITH_MORE) : ids,
      more: more ? ids.slice(SEGMENTS_WITH_MORE) : [],
      ...slotOf(ctx),
      rule: "R3",
      destinations,
    };
  }

  /** A block's content: mod view, R7 agent terminal, fixed terminal, or R6 pane group. */
  private content(n: LayoutNode, ctx: Ctx): ScreenNode {
    const c: JsonObject = n.content ?? {};
    const size = slotOf(ctx);
    if (typeof c.mod === "string" && c.mod !== "") {
      return { kind: "block", id: ctx.id, view: `${c.mod}:${ctx.id}`, ...size };
    }
    if (c.agent === "focused") return { kind: "terminal", id: ctx.id, agent: "focused", ...size, rule: "R7" };
    if (typeof c.terminal === "string" && c.terminal !== "") {
      return { kind: "terminal", id: ctx.id, terminal: c.terminal, ...size };
    }
    if (c.tab === "active") {
      const header = is(PaneOptionsSchema, c.pane) ? c.pane.header : undefined;
      return {
        kind: "panes",
        id: ctx.id,
        mode: this.phone ? "pager" : "split",
        ...(header
          ? {
            header: {
              folder: header.content.mod,
              props: header.content.props ?? {},
              height: header.height ?? PANE_HEADER_DEFAULT_PX,
              position: header.position ?? "top",
            },
          }
          : {}),
        ...size,
        rule: "R6",
      };
    }
    return emptyBox(ctx);
  }

  /** R1: a bar; its content is converted as drawn (no reclassification). */
  private bar(p: Part, parentAxis: Axis, ctx: Ctx): ScreenNode {
    const t = typeOf(p.node);
    const axis: Axis = t === "row" || t === "column" ? t : parentAxis;
    const inner: Ctx = { id: p.id, path: p.path, ancestors: ctx.ancestors };
    return {
      kind: "bar",
      id: p.id,
      axis,
      px: pxOf(p.node) ?? 0,
      rule: "R1",
      children: t === "block" ? [this.content(p.node, inner)] : this.plainChildren(p.node, inner),
    };
  }

  /** Content of a bar: kept as the layout draws it. */
  private plain(n: LayoutNode, ctx: Ctx): ScreenNode {
    const t = typeOf(n);
    if (t === "block") return this.content(n, ctx);
    if (t === "stack") return this.group(n, ctx, "tabs", false);
    return { kind: "split", id: ctx.id, axis: t, ...slotOf(ctx), children: this.plainChildren(n, ctx) };
  }

  private plainChildren(n: LayoutNode, ctx: Ctx): ScreenNode[] {
    const ancestors = [ctx.id, ...ctx.ancestors];
    return kidsOf(n, ctx.path)
      .filter((k) => !k.node.hidden)
      .map((k) => this.plain(k.node, { id: k.id, path: k.path, ancestors, ...this.slotIn(k.node) }));
  }

  /** Registers a route (in document order: before its own nested routes) and converts its screen. */
  private route(
    p: Part,
    ctx: Ctx,
    open: ScreenRoute["open"],
    opts: { side?: "left" | "right"; rule?: RecomposeRule; path?: string },
  ): ScreenRoute {
    let path = opts.path ?? `/${p.id}`;
    for (let i = 2; this.paths.has(path); i++) path = `${opts.path ?? `/${p.id}`}~${i}`;
    this.paths.add(path);
    const route: ScreenRoute = {
      path,
      node: p.id,
      open,
      ...(opts.side ? { side: opts.side } : {}),
      ...(opts.rule ? { rule: opts.rule } : {}),
      mounted: !p.node.hidden,
      screen: emptyBox(ctx),
    };
    this.routes.push(route);
    route.screen = this.convert(p.node, { ...ctx, size: undefined, resize: undefined });
    return route;
  }

  /**
   * A child's slot in its parent: `size` (`px` clamped to `min`/`max`, or `weight`) and, for an `overridable()` node,
   * `resize` (how this device may change it) with its bounds (`min`/`max`) in `size`; other nodes carry no bounds.
   */
  private slotIn(n: LayoutNode): Slotted {
    const info = this.resizable.get(n);
    const min = info ? nonNegative(n.min) : undefined;
    const max = info ? nonNegative(n.max) : undefined;
    const px = pxOf(n);
    const weight = px === undefined ? nonNegative(n.size?.weight) : undefined;
    const size: ScreenSize = {
      ...(px !== undefined ? { px } : {}),
      ...(weight !== undefined ? { weight } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    };
    return {
      ...(Object.keys(size).length > 0 ? { size } : {}),
      ...(info ? { resize: { kind: info.kind, collapsible: info.collapsible } } : {}),
    };
  }

  /** R4: the floating entries of every on-screen node (shown, active destination), in document order. */
  sheets(tree: LayoutNode): ScreenSheet[] {
    const out: ScreenSheet[] = [];
    const visit = (n: LayoutNode, path: string, ancestors: string[]) => {
      const id = idOf(n, path);
      (n.floating ?? []).forEach((f, i) => {
        if (f.hidden) return;
        const fpath = `${path}.f${i}`;
        out.push(this.sheet(f, { id: idOf(f, fpath), path: fpath, ancestors: [id, ...ancestors] }));
      });
      const t = typeOf(n);
      if (t === "block") return;
      const kids = kidsOf(n, path);
      const active = t === "stack" ? activeOf(n, kids.map((k) => k.id)) : undefined;
      for (const k of kids) {
        if (!k.node.hidden && (active === undefined || k.id === active)) visit(k.node, k.path, [id, ...ancestors]);
      }
    };
    visit(tree, "r", []);
    return out;
  }

  private sheet(f: LayoutNode, ctx: Ctx): ScreenSheet {
    const screen = this.content(f, ctx);
    const peek = nonNegative(f.peek);
    if (this.phone) {
      return {
        id: ctx.id,
        edge: "bottom",
        align: "center",
        ...(peek !== undefined ? { peek: PEEK_HANDLE_PX } : {}),
        rule: "R4",
        screen,
      };
    }
    const edge = EDGES.find((e) => e === f.edge) ?? "bottom";
    return {
      id: ctx.id,
      edge,
      align: ALIGNS.find((a) => a === f.align) ?? "center",
      ...(peek !== undefined && (edge === "left" || edge === "right") ? { peek } : {}),
      rule: "R4",
      screen,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers.

const EDGES = ["top", "right", "bottom", "left"] as const;
const ALIGNS = ["start", "center", "end"] as const;

/** A usable size value: a finite number ≥ 0 (screen sizes cannot be negative). */
function nonNegative(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  const x = a as JsonObject;
  const y = b as JsonObject;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => Object.hasOwn(y, k) && jsonEqual(x[k], y[k]));
}

/**
 * A node's fixed size as shown: `size.px` clamped to its `min`/`max` (a click can save a size outside the bounds; lstack's
 * `.state` has `panel` at 24 px with `min: 280`). [I] Herdr's own clamping is not published.
 */
function pxOf(n: LayoutNode): number | undefined {
  const px = nonNegative(n.size?.px);
  if (px === undefined) return undefined;
  const min = nonNegative(n.min) ?? 0;
  const max = nonNegative(n.max) ?? Infinity;
  return Math.min(Math.max(px, min), Math.max(max, min));
}

function* walk(n: LayoutNode): Generator<LayoutNode> {
  yield n;
  for (const c of n.children ?? []) yield* walk(c);
  for (const f of n.floating ?? []) yield* walk(f);
}

function indexById(tree: LayoutNode): Map<string, LayoutNode> {
  const m = new Map<string, LayoutNode>();
  for (const n of walk(tree)) if (typeof n.id === "string" && !m.has(n.id)) m.set(n.id, n);
  return m;
}

function typeOf(n: LayoutNode): NodeType {
  const t = n.type;
  if (t === "row" || t === "column" || t === "stack" || t === "block") return t;
  return n.content === undefined && n.children ? "column" : "block";
}

/** A node's id; a node without one gets `#<path>` (stable while the file is unchanged). */
function idOf(n: LayoutNode, path: string): string {
  return typeof n.id === "string" && n.id !== "" ? n.id : `#${path}`;
}

function kidsOf(n: LayoutNode, path: string): Kid[] {
  return (n.children ?? []).map((node, i) => ({ node, id: idOf(node, `${path}.${i}`), path: `${path}.${i}` }));
}

/** A stack's shown child: `active` when it names a child, else the first. */
function activeOf(n: LayoutNode, ids: string[]): string {
  return typeof n.active === "string" && ids.includes(n.active) ? n.active : ids[0];
}

/** R1/R2 roles of a row/column's children. */
function classify(parent: LayoutNode, axis: Axis, path: string): Part[] {
  const parts: Part[] = kidsOf(parent, path).map((k) => {
    const px = pxOf(k.node);
    const bounded = (nonNegative(k.node.min) ?? nonNegative(k.node.max)) !== undefined;
    if (typeOf(k.node) !== "stack" && px !== undefined && px <= BAR_MAX_PX && !bounded) return { ...k, role: "bar" };
    const panel = px !== undefined || (bounded && nonNegative(k.node.size?.weight) === undefined);
    return { ...k, role: axis === "row" && panel ? "panel" : "main" };
  });
  if (axis !== "row") return parts;
  let main = parts.findIndex((p) => p.role === "main");
  if (main < 0) {
    // A row of panels only: the first one is main.
    main = parts.findIndex((p) => p.role === "panel");
    if (main < 0) return parts;
    parts[main] = { ...parts[main], role: "main" };
  }
  return parts.map((p, i) => (p.role === "panel" ? { ...p, side: i < main ? "left" : "right" } : p));
}

/** The main child that stays in place: the first shown one (others become routes on a phone). */
function primaryMain(parts: Part[]): Part | undefined {
  return parts.find((p) => p.role === "main" && !p.node.hidden) ?? parts.find((p) => p.role === "main");
}

function childCtx(p: Kid, ancestors: string[], slot: Slotted = {}): Ctx {
  return { id: p.id, path: p.path, ancestors, ...slotOf(slot) };
}

/** A node's `size` and `resize` from its slot, without absent keys. */
function slotOf(slot: Slotted): Slotted {
  return { ...(slot.size ? { size: slot.size } : {}), ...(slot.resize ? { resize: slot.resize } : {}) };
}

function emptyBox(ctx: Ctx): ScreenNode {
  return { kind: "split", id: ctx.id, axis: "column", ...slotOf(ctx), children: [] };
}

function homeRoute(node: string, screen: ScreenNode): ScreenRoute {
  return { path: HOME_ROUTE, node, open: "root", mounted: true, screen };
}

/** Phone: a split with one child that can take its slot's size becomes that child. */
function collapse(split: ScreenNode & { kind: "split" }): ScreenNode {
  if (split.children.length !== 1) return split;
  const only = split.children[0];
  if (only.kind === "bar" || only.kind === "link") return split;
  const out = { ...only };
  delete out.size;
  delete out.resize;
  return { ...out, ...slotOf(split) };
}

/**
 * A destination's segment label: the node's `title`, else its id without a `-<ancestor id>` suffix or `<ancestor id>-`
 * prefix that only disambiguates it (lstack `runbook-panel` inside `panel` → "runbook").
 */
function titleOf(n: LayoutNode, id: string, ancestors: string[]): string {
  if (typeof n.title === "string" && n.title !== "") return n.title;
  for (const a of ancestors) {
    if (id.length > a.length + 1 && id.endsWith(`-${a}`)) return id.slice(0, -a.length - 1);
    if (id.length > a.length + 1 && id.startsWith(`${a}-`)) return id.slice(a.length + 1);
  }
  return id;
}
