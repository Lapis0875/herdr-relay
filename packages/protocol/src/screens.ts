/**
 * Device classes and the recomposition vocabulary of DESIGN.md §3: `recompose(layout, clickState, device) →
 * ScreenGraph` (implemented in `recompose.ts`, T04) turns a Herdr layout into routes, bars, screen groups, pane groups
 * and sheets that the client navigator (T15) renders. Screen nodes name layout node ids; the look of each node
 * (radius, border, background, padding, gap) stays in the layout tree the client receives in `hello.layout`.
 */

import {
  array,
  boolean,
  define,
  enumOf,
  type JsonObject,
  jsonObjectRef,
  literal,
  number,
  object,
  type Same,
  type Schema,
  type Static,
  string,
  tagged,
} from "./schema.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Device classes.

export const DEVICE_CLASSES = ["phone", "tablet-portrait", "tablet-landscape", "desktop"] as const;
export const DeviceClassSchema = define("DeviceClass", () => enumOf(DEVICE_CLASSES));
export type DeviceClass = Static<typeof DeviceClassSchema>;

/** A phone's shortest side is below this many CSS px (dp). */
export const PHONE_MAX_SHORT_SIDE = 600;
/** From this width a tablet is `tablet-landscape`. */
export const TABLET_LANDSCAPE_MIN_WIDTH = 1024;
/** From this width, with a fine pointer, a device is `desktop`. */
export const DESKTOP_MIN_WIDTH = 1280;

/**
 * The device class for a viewport in CSS px (DESIGN.md §3): `phone` when the shortest side is < 600, `desktop` when
 * the width is ≥ 1280 and the primary pointer is fine (mouse/trackpad), else `tablet-landscape` from width 1024 and
 * `tablet-portrait` below. iPad Split View changes the class live.
 */
export function classifyDevice(viewport: { w: number; h: number }, finePointer: boolean): DeviceClass {
  if (Math.min(viewport.w, viewport.h) < PHONE_MAX_SHORT_SIDE) return "phone";
  if (finePointer && viewport.w >= DESKTOP_MIN_WIDTH) return "desktop";
  return viewport.w >= TABLET_LANDSCAPE_MIN_WIDTH ? "tablet-landscape" : "tablet-portrait";
}

// ---------------------------------------------------------------------------------------------------------------------
// Rules R1–R7.

/**
 * DESIGN.md §3 classification rules, applied top-down on node structure (never on ids):
 * - `R1` bars: a block or row/column with fixed `size.px ≤ 72` along its parent's main axis stays in place.
 * - `R2` side panels: in a row, a non-bar child with fixed px (or min/max) is a panel; leading = left, trailing = right.
 * - `R3` stacks: a stack is a screen group; its direct children are destinations; `active` is shown.
 * - `R4` floating: a floating entry is a sheet; `peek` → collapsed handle.
 * - `R5` hidden: `hidden:true` → the destination exists but is not mounted.
 * - `R6` tab block: `{tab:"active"}` is a pane group (its pane tree is a split tree).
 * - `R7` agent block: `{agent:"focused"}` is a single terminal screen.
 */
export const RECOMPOSE_RULES = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"] as const;
export const RecomposeRuleSchema = define("RecomposeRule", () => enumOf(RECOMPOSE_RULES));
export type RecomposeRule = Static<typeof RecomposeRuleSchema>;

/** R1: the largest fixed main-axis size, in px, of a bar. */
export const BAR_MAX_PX = 72;
/** Phone: a stack with at most this many destinations becomes a bottom segmented control. */
export const SEGMENTS_MAX = 5;
/** Phone: a larger stack shows this many segments plus a "More" sheet. */
export const SEGMENTS_WITH_MORE = 4;
/** Phone: the grab handle of a `peek` sheet and the collapsed rail, in px. */
export const PEEK_HANDLE_PX = 44;

// ---------------------------------------------------------------------------------------------------------------------
// ScreenGraph.

/** A layout node's size as recomposed (px fixed, weight shared; min/max: the bounds of a node that has `resize`). */
export const ScreenSizeSchema = define("ScreenSize", () =>
  object({}, {
    px: number({ minimum: 0 }),
    weight: number({ minimum: 0 }),
    min: number({ minimum: 0 }),
    max: number({ minimum: 0 }),
  }));
export type ScreenSize = Static<typeof ScreenSizeSchema>;

/**
 * A split child this device may resize (`overridable()`: what a client `layout set` accepts for it), on tablet and
 * desktop classes: `kind` is the size a change sets (`px` fixed, `weight` a share among weighted siblings) along the
 * parent split's axis; `collapsible`: an R2 panel that also takes `collapsed` (drawn as its rail, `size.min` else
 * 44 px), whose current state is the node's own `collapsed` (`ScreenSlot`, always present then). Bounds are
 * `size.min`/`max` where the layout has them; a node without them is still resizable.
 */
export const ScreenResizeSchema = define(
  "ScreenResize",
  () => object({ kind: enumOf(["px", "weight"]), collapsible: boolean() }),
);
export type ScreenResize = Static<typeof ScreenResizeSchema>;

/** A destination of a screen group (a direct child of a layout stack). */
export interface ScreenDestination {
  /** Layout node id. */
  id: string;
  /** Segment label. */
  title: string;
  /** R5: `false` while hidden (exists, not mounted). */
  mounted: boolean;
  screen: ScreenNode;
}

/** How a node sits in its parent split (split, block, group, panes and terminal nodes). */
export interface ScreenSlot {
  size?: ScreenSize;
  resize?: ScreenResize;
  /**
   * An R2 panel's state: `true` while it is drawn as its rail (`size.px` = its `min`, else 44 px: tablet-portrait
   * leading panels, or the device's profile), `false` while a collapsible one (`resize.collapsible`) is expanded —
   * always present on collapsible panels, so a panel expanded at its `min` is told apart from its rail. Absent on
   * other nodes.
   */
  collapsed?: boolean;
}

/** Row/column split (desktop/tablet trees, phone columns). */
export interface SplitScreen extends ScreenSlot {
  kind: "split";
  id: string;
  axis: "row" | "column";
  rule?: RecomposeRule;
  children: ScreenNode[];
}
/** R1: a bar kept in place on every class (a bar block has itself as its only child). */
export interface BarScreen {
  kind: "bar";
  id: string;
  axis: "row" | "column";
  px: number;
  rule?: RecomposeRule;
  children: ScreenNode[];
}
/** A mod block: renders view `view` (`<folder>:<blockId>`). */
export interface BlockScreen extends ScreenSlot {
  kind: "block";
  id: string;
  view: string;
  rule?: RecomposeRule;
}
/** R3: a stack as a screen group with its navigation control. */
export interface GroupScreen extends ScreenSlot {
  kind: "group";
  id: string;
  active: string;
  /** `segments`: bottom segmented control (phone); `tabs`: kept as the layout draws it (tablet/desktop). */
  nav: "segments" | "tabs";
  /** Destination ids shown as segments, in order. */
  shown: string[];
  /** Destination ids behind "More" (phone, > 5 destinations). */
  more: string[];
  rule?: RecomposeRule;
  destinations: ScreenDestination[];
}
/** R6: the active tab's panes; header copies are `<folder>:pane:<paneId>`. */
export interface PanesScreen extends ScreenSlot {
  kind: "panes";
  id: string;
  /** `pager`: one pane at a time (phone); `split`: the tab's split tree (tablet/desktop). */
  mode: "pager" | "split";
  header?: { folder: string; props: JsonObject; height: number; position: "top" | "bottom" };
  rule?: RecomposeRule;
}
/** R7 (`agent:"focused"`) or a fixed `{terminal}` block. */
export interface TerminalScreen extends ScreenSlot {
  kind: "terminal";
  id: string;
  agent?: "focused";
  terminal?: string;
  rule?: RecomposeRule;
}
/** A panel recomposed into its own route (R2 inside main, phone): a button that pushes `route`. */
export interface LinkScreen {
  kind: "link";
  id: string;
  route: string;
  rule?: RecomposeRule;
}

export type ScreenNode =
  | SplitScreen
  | BarScreen
  | BlockScreen
  | GroupScreen
  | PanesScreen
  | TerminalScreen
  | LinkScreen;

export const ScreenNodeSchema: Schema<ScreenNode> = define("ScreenNode", () => screenNodeBody);

const id = () => string({ minLength: 1 });
const axis = () => enumOf(["row", "column"]);
const rule = { rule: RecomposeRuleSchema };
/** `ScreenSlot`: the size a split child takes in its parent, whether this device may resize it, and its rail state. */
const slot = { size: ScreenSizeSchema, resize: ScreenResizeSchema, collapsed: boolean() };

const destinationBody = object({ id: id(), title: string(), mounted: boolean(), screen: ScreenNodeSchema });

const screenNodeBody = tagged("kind", [
  object(
    { kind: literal("split"), id: id(), axis: axis(), children: array(ScreenNodeSchema) },
    { ...slot, ...rule },
  ),
  object(
    { kind: literal("bar"), id: id(), axis: axis(), px: number({ minimum: 0 }), children: array(ScreenNodeSchema) },
    rule,
  ),
  object({ kind: literal("block"), id: id(), view: id() }, { ...slot, ...rule }),
  object({
    kind: literal("group"),
    id: id(),
    active: id(),
    nav: enumOf(["segments", "tabs"]),
    shown: array(id()),
    more: array(id()),
    destinations: array(destinationBody, { minItems: 1 }),
  }, { ...slot, ...rule }),
  object({ kind: literal("panes"), id: id(), mode: enumOf(["pager", "split"]) }, {
    header: object({
      folder: id(),
      props: jsonObjectRef,
      height: number({ minimum: 0 }),
      position: enumOf(["top", "bottom"]),
    }),
    ...slot,
    ...rule,
  }),
  object({ kind: literal("terminal"), id: id() }, {
    agent: literal("focused"),
    terminal: id(),
    ...slot,
    ...rule,
  }),
  object({ kind: literal("link"), id: id(), route: string({ pattern: "^/" }) }, rule),
]);

const _screenNodeMatches: Same<Static<typeof screenNodeBody>, ScreenNode> = true;

/** One navigator route. */
export const ScreenRouteSchema = define("ScreenRoute", () =>
  object({
    /** `/` for the home route, `/<layout node id>` for the others. */
    path: string({ pattern: "^/" }),
    /** Layout node id at the route's root. */
    node: id(),
    /** `root`: the home route; `drawer`: edge-swipe from `side`; `push`: pushed on the stack; `sheet`: overlay sheet. */
    open: enumOf(["root", "drawer", "push", "sheet"]),
    mounted: boolean(),
    screen: ScreenNodeSchema,
  }, { side: enumOf(["left", "right"]), rule: RecomposeRuleSchema }));
export type ScreenRoute = Static<typeof ScreenRouteSchema>;

/** R4: a floating layout entry as a bottom sheet (`peek` → collapsed handle). */
export const ScreenSheetSchema = define("ScreenSheet", () =>
  object({
    id: id(),
    edge: enumOf(["top", "right", "bottom", "left"]),
    align: enumOf(["start", "center", "end"]),
    screen: ScreenNodeSchema,
  }, { peek: number({ minimum: 0 }), rule: RecomposeRuleSchema }));
export type ScreenSheet = Static<typeof ScreenSheetSchema>;

/**
 * The recomposed layout for one device class plus the session's navigator stack (`stack[0]` is `/`; the last entry is
 * on screen). Sent in `hello.screens` and replaced in `patch.screens` (also whenever the shown layout is edited or
 * switched: `layout` is the layout shown now, `hello.layout` only the one the connection started with). Split children
 * this device may resize carry `resize`. `overridden`: the ids of the nodes this device's layout profile (this layout,
 * this class) resizes or collapses here — `overridable()` nodes whose entry has a size of the node's kind, or a
 * boolean `collapsed` on a collapsible one — sorted; absent when none.
 */
export const ScreenGraphSchema = define("ScreenGraph", () =>
  object({
    v: literal(1),
    layout: string({ minLength: 1 }),
    class: DeviceClassSchema,
    routes: array(ScreenRouteSchema, { minItems: 1 }),
    sheets: array(ScreenSheetSchema),
    stack: array(string({ pattern: "^/" }), { minItems: 1 }),
  }, { overridden: array(id()) }));
export type ScreenGraph = Static<typeof ScreenGraphSchema>;

/** Viewport reported by a device (`hello.viewport`). */
export const ViewportSchema = define("Viewport", () =>
  object({
    w: number({ exclusiveMinimum: 0, description: "CSS px" }),
    h: number({ exclusiveMinimum: 0, description: "CSS px" }),
    dpr: number({ exclusiveMinimum: 0 }),
  }));
export type Viewport = Static<typeof ViewportSchema>;
