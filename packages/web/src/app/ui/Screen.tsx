/**
 * Draws one ScreenNode tree (DESIGN.md §3): splits and bars as flex boxes sized by the layout (`px` fixed, `weight`
 * shared, rails collapsed), blocks as view slots (`renderView`), R7 terminals as terminal slots, R3 groups with their
 * navigation control (phone `segments`: a bottom bar for the outermost group of a route, a compact segmented
 * control above nested ones, "More" for the overflow; `tabs`: drawn by the layout's own mods), R6 pane groups as a
 * pager (phone) or side by side (tablet), and links as rows that push their route. Each node also takes its layout
 * node's look (background, radius, border, padding, gap, shadow).
 *
 * Device layout profile (tablet and desktop): a handle (`role="separator"`) sits between two split children where one
 * is a node the latest ScreenGraph marks `resize` (the bridge accepts exactly those). Dragging it moves a guide line
 * only; releasing sends one `layout set` (a weight pair: both siblings in it, their sum kept). Arrow keys step 10 px
 * (Shift: 50), Home/End go to the drag limits, Enter/Space collapse or expand an R2 panel, Escape cancels. Limits come
 * from the graph's `min`/`max`, else {@link UNBOUNDED_MIN_PX} to {@link MAX_SHARE} of the split (a weight: at least
 * {@link MIN_SHARE} of the pair). Dropping a collapsible panel within {@link SNAP_PX} of its lower limit collapses it;
 * a collapsed split panel (rail) shows an expand button that restores its last size.
 */

import {
  createContext,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BAR_MAX_PX,
  type DeviceClass,
  type LayoutNode,
  type NodeProfile,
  type PaneInfo,
  PEEK_HANDLE_PX,
  type ScreenNode,
  type ScreenSize,
} from "@herdr-relay/protocol";
import { systemKey } from "../../render/events.ts";
import { bridge } from "../client.ts";
import { titleOf } from "../nav.ts";
import { renderTerminal, renderView } from "../slots.tsx";
import { useApp } from "../store.ts";
import { lookStyle } from "../theme.ts";
import { Icon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";
import { ShellButton } from "./Status.tsx";

type Axis = "row" | "column";
type GroupNode = Extract<ScreenNode, { kind: "group" }>;
type PanesNode = Extract<ScreenNode, { kind: "panes" }>;
type BarNode = Extract<ScreenNode, { kind: "bar" }>;
type SplitNode = Extract<ScreenNode, { kind: "split" }>;

export interface ScreenCtx {
  /** Layout nodes by id (`hello.layout.tree`): their look. */
  index: ReadonlyMap<string, LayoutNode>;
  deviceClass: DeviceClass;
  /** The bar that carries the shell button at its leading edge (`null`: none on this screen). */
  leadingBar: string | null;
}

export const ScreenContext = createContext<ScreenCtx>({ index: new Map(), deviceClass: "phone", leadingBar: null });

/** Flex sizing of a node along its parent's axis. */
function flexOf(size: ScreenSize | undefined, axis: Axis): CSSProperties {
  if (size?.px !== undefined) {
    return { flex: `0 0 ${size.px}px`, [axis === "row" ? "width" : "height"]: size.px };
  }
  if (size?.weight !== undefined) return { flex: `${size.weight} 1 0` };
  return { flex: "1 1 0" };
}

export interface ScreenViewProps {
  node: ScreenNode;
  /** The parent's main axis. */
  axis: Axis;
  /** This node fills a whole route or sheet: no card frame. */
  root?: boolean;
  /** How many `segments` groups enclose this node on its route. */
  segDepth?: number;
  /** A collapsed R2 panel this device may expand: its rail shows the expand button. */
  rail?: Rail;
}

export function ScreenView({ node, axis, root = false, segDepth = 0, rail }: ScreenViewProps): ReactElement {
  const ctx = useContext(ScreenContext);
  const pending = useApp((s) => pendingOf(s.sizing, node.id));
  const look = lookStyle(ctx.index.get(node.id), !root);
  const fill: CSSProperties = root ? { flex: "1 1 0" } : {};
  const drawn = drawnOf(node, pending);
  const sized: CSSProperties = { ...flexOf(drawn.size, axis), ...fill };
  switch (node.kind) {
    case "split":
      return (
        <Split node={node} collapsed={drawn.collapsed} style={{ ...sized, ...look }} segDepth={segDepth} rail={rail} />
      );
    case "bar":
      return <Bar node={node} axis={axis} look={look} segDepth={segDepth} />;
    case "block":
      return (
        <div className="sn-block" data-node={node.id} style={{ ...sized, ...look }}>
          {renderView(node.view)}
        </div>
      );
    case "terminal":
      return (
        <div className="sn-terminal" data-node={node.id} style={{ ...sized, ...look }}>
          {renderTerminal({ id: node.id, terminal: node.terminal, agent: node.agent })}
        </div>
      );
    case "link":
      return <LinkRow id={node.id} route={node.route} />;
    case "group":
      return <Group node={node} style={sized} look={look} segDepth={segDepth} />;
    case "panes":
      return <Panes node={node} style={{ ...sized, ...look }} />;
  }
}

/** This device's unconfirmed `layout set` for node `id` (own entries only: an id may be `__proto__`). */
function pendingOf(sizing: Readonly<Record<string, NodeProfile>>, id: string): NodeProfile | undefined {
  return Object.hasOwn(sizing, id) ? sizing[id] : undefined;
}

/**
 * A node as drawn: its graph size and rail state (the graph's `collapsed`, never inferred from a width: a panel expanded
 * at its `min` is as wide as its rail) with this device's unconfirmed `layout set` (`sizing`) applied.
 */
function drawnOf(node: ScreenNode, pending: NodeProfile | undefined): { size?: ScreenSize; collapsed: boolean } {
  const size = "size" in node ? node.size : undefined;
  const collapsed = "collapsed" in node && node.collapsed === true;
  if (!pending) return { size, collapsed };
  if (pending.collapsed === true) return { size: { ...size, px: size?.min ?? PEEK_HANDLE_PX }, collapsed: true };
  if (pending.px !== undefined) return { size: { ...size, px: pending.px }, collapsed: pending.collapsed ?? collapsed };
  if (pending.weight !== undefined) return { size: { ...size, weight: pending.weight }, collapsed };
  // Expanding to the size the bridge kept: drawn when its graph arrives.
  return { size, collapsed };
}

// ---------------------------------------------------------------------------------------------------------------------
// Splits and their resize handles (device layout profile).

/** A rail's expand button: the panel's title, and which edge of the split the panel sits on. */
interface Rail {
  title: string;
  side: "start" | "end";
}

/** Pointer travel before a press on a handle becomes a drag, in px. */
const DRAG_SLOP_PX = 4;
/** A collapsible panel dropped less than this above its lower limit collapses to its rail. */
const SNAP_PX = 24;
const KEY_STEP_PX = 10;
const KEY_STEP_LARGE_PX = 50;
/** Arrow-key steps are sent as one `layout set` once the keys rest this long (or the handle loses focus). */
const KEY_COMMIT_MS = 600;
/** A dragged panel always leaves its flexible neighbour this much, in px. */
const NEIGHBOUR_FLOOR_PX = 120;
/** The lower limit of a px node without `min`: the bridge keeps an unbounded panel wider than an R1 bar. */
const UNBOUNDED_MIN_PX = BAR_MAX_PX + 1;
/** The upper limit of a px node without `max`: this share of its split. */
const MAX_SHARE = 0.8;
/** The least share of a weight pair's space either sibling keeps. */
const MIN_SHARE = 0.1;
/**
 * The grip's reach from its centre, in px: a press this close (across the edge, and along it) is on the grip, and a tap
 * there collapses or expands an R2 panel. Its touch target in `app.css` (44 × 88 px) lies within.
 */
const GRIP_HIT_PX = 44;

/** A split child this device may resize (the graph's `resize`), as drawn now. */
interface Side {
  id: string;
  kind: "px" | "weight";
  /** Drawn size along the split (px handles; `undefined`: flexible until resized). */
  px?: number;
  /** Drawn weight (weight handles). */
  weight: number;
  min?: number;
  max?: number;
  collapsible: boolean;
  collapsed: boolean;
  /** The rail's size: `min`, else {@link PEEK_HANDLE_PX}. */
  rail: number;
}

/** Split child `c` as a handle side, or `null` when the graph does not mark it `resize` (this device may not). */
function sideOf(c: ScreenNode, pending: NodeProfile | undefined): Side | null {
  if (!("resize" in c) || !c.resize) return null;
  const { kind, collapsible } = c.resize;
  const { size, collapsed: railed } = drawnOf(c, pending);
  const rail = size?.min ?? PEEK_HANDLE_PX;
  const collapsed = collapsible && railed;
  return {
    id: c.id,
    kind,
    px: size?.px,
    weight: size?.weight ?? 1,
    ...(size?.min !== undefined ? { min: size.min } : {}),
    ...(size?.max !== undefined ? { max: size.max } : {}),
    collapsible,
    collapsed,
    rail,
  };
}

/**
 * What the handle between two split children resizes: one px node (`sign` 1: the leading child, its trailing edge;
 * -1: the trailing child, its leading edge), or two weighted siblings sharing their space.
 */
type Handle =
  | { kind: "px"; side: Side; sign: 1 | -1; label: string }
  | { kind: "weight"; a: Side; b: Side; label: string };

function handleOf(sa: Side | null, sb: Side | null): Handle | null {
  if (sa?.kind === "weight" && sb?.kind === "weight") {
    return { kind: "weight", a: sa, b: sb, label: `Resize ${titleOf(sa.id)} and ${titleOf(sb.id)}` };
  }
  const pa = sa?.kind === "px" ? sa : null;
  const pb = sb?.kind === "px" ? sb : null;
  // Two px panels side by side: the edge belongs to the collapsible one, else the leading one.
  if (pa && !(pb?.collapsible && !pa.collapsible)) {
    return { kind: "px", side: pa, sign: 1, label: `Resize ${titleOf(pa.id)}` };
  }
  if (pb) return { kind: "px", side: pb, sign: -1, label: `Resize ${titleOf(pb.id)}` };
  return null;
}

function Split(
  { node, collapsed, style, segDepth, rail }: {
    node: SplitNode;
    collapsed: boolean;
    style: CSSProperties;
    segDepth: number;
    rail?: Rail;
  },
): ReactElement {
  const ctx = useContext(ScreenContext);
  const sizing = useApp((s) => s.sizing);
  const look = ctx.index.get(node.id);
  const resizable = ctx.deviceClass !== "phone";
  const kids = node.children;
  const sides = kids.map((c) => (resizable ? sideOf(c, pendingOf(sizing, c.id)) : null));
  // A rail's expand button sits after its leading bars (the rail's header), or last when it holds only bars.
  const first = kids.findIndex((c) => c.kind !== "bar" && c.kind !== "link");
  const head = rail && collapsed ? (first < 0 ? kids.length : first) : -1;
  const items: ReactElement[] = [];
  kids.forEach((c, i) => {
    // Bars and links keep their edges: a handle only sits between two children that flow.
    const flows = i > 0 && ![kids[i - 1].kind, c.kind].some((k) => k === "bar" || k === "link");
    const h = flows ? handleOf(sides[i - 1], sides[i]) : null;
    if (h) items.push(<SplitHandle key={`${c.id}:handle`} axis={node.axis} handle={h} />);
    if (i === head) items.push(<RailExpand key="rail-expand" id={node.id} rail={rail!} />);
    const s = sides[i];
    const r: Rail | undefined = s?.collapsed && c.kind === "split"
      ? {
        title: titleOf(c.id),
        side: kids.slice(i + 1).some((k) => k.kind !== "bar" && k.kind !== "link") ? "start" : "end",
      }
      : undefined;
    items.push(<ScreenView key={c.id} node={c} axis={node.axis} segDepth={segDepth} rail={r} />);
  });
  if (head >= kids.length) items.push(<RailExpand key="rail-expand" id={node.id} rail={rail!} />);
  const gap = typeof look?.gap === "number" ? look.gap : 0;
  return (
    <div
      className={`sn-split${collapsed ? " sn-split--rail" : ""}`}
      data-axis={node.axis}
      data-node={node.id}
      style={{ ...style, ["--sn-gap" as string]: `${gap}px` }}
    >
      {items}
    </div>
  );
}

/** A rail's expand button: opens the panel at the size the bridge kept for it, and keeps focus on its handle. */
function RailExpand({ id, rail }: { id: string; rail: Rail }): ReactElement {
  const live = useApp((s) => s.conn.kind === "live");
  const expand = (button: HTMLElement) => {
    const railEl = button.closest(".sn-split--rail");
    const handle = rail.side === "start" ? railEl?.nextElementSibling : railEl?.previousElementSibling;
    if (handle instanceof HTMLElement && handle.classList.contains("sn-sep")) handle.focus({ preventScroll: true });
    void bridge.setLayout([{ node: id, collapsed: false }]);
  };
  return (
    <button
      type="button"
      className="sn-rail-expand"
      aria-label={`Expand ${rail.title}`}
      aria-expanded={false}
      disabled={!live}
      onClick={(e) => expand(e.currentTarget)}
    >
      <Icon name={rail.side === "start" ? "forward" : "back"} size={18} />
    </button>
  );
}

/** What a handle may set, measured from the drawn split: the resized size now and its limits. */
interface Range {
  /** The resized size at the start: the px node's, or a weight pair's leading child's. */
  start: number;
  /** Its drag limits (Home/End). */
  lo: number;
  hi: number;
  /** Dropped below this, a collapsible panel collapses (-Infinity: never). */
  snap: number;
  /** Weight pair: both children's sizes together. */
  total: number;
}

/** A drag or a run of arrow keys on a handle, measured when it started. */
interface Gesture extends Range {
  /** The dragging pointer (`null`: keys). */
  pointer: number | null;
  /** Pointer position along the split axis at the press. */
  from: number;
  moved: boolean;
  /** Pressed on the grip (a tap there collapses or expands). */
  grip: boolean;
}

/** Where the guide shows the new size: `offset` from the handle along the axis, `cross` the label's position across. */
interface Preview {
  size: number;
  collapse: boolean;
  offset: number;
  cross: number | null;
}

function extentOf(el: Element | null, axis: Axis): number {
  if (!el) return 0;
  const r = el.getBoundingClientRect();
  return axis === "row" ? r.width : r.height;
}

/**
 * The range of handle `h` (element `el`, between the children it resizes): the graph's `min`/`max` where it has them,
 * else {@link UNBOUNDED_MIN_PX} up to {@link MAX_SHARE} of the split for a px node, and at least {@link MIN_SHARE} of
 * the pair for each weighted sibling; a px node also leaves its neighbour {@link NEIGHBOUR_FLOOR_PX}.
 */
function rangeOf(el: HTMLElement, axis: Axis, h: Handle): Range {
  const prev = el.previousElementSibling;
  const next = el.nextElementSibling;
  if (h.kind === "weight") {
    const start = extentOf(prev, axis);
    const total = start + extentOf(next, axis);
    let lo = Math.max(h.a.min ?? 0, total * MIN_SHARE, total - (h.b.max ?? Infinity));
    let hi = Math.min(h.a.max ?? Infinity, total * (1 - MIN_SHARE), total - (h.b.min ?? 0));
    if (lo > hi) lo = hi = start;
    return { start, lo, hi, snap: -Infinity, total };
  }
  const s = h.side;
  const start = extentOf(h.sign === 1 ? prev : next, axis);
  const room = Math.max(0, extentOf(h.sign === 1 ? next : prev, axis) - NEIGHBOUR_FLOOR_PX);
  const lo = s.min ?? UNBOUNDED_MIN_PX;
  const cap = s.max ?? MAX_SHARE * extentOf(el.parentElement, axis);
  const hi = Math.max(lo, Math.min(cap, start + room));
  return { start, lo, hi, snap: s.collapsible ? lo + SNAP_PX : -Infinity, total: 0 };
}

/**
 * A tap on the handle's strip outside its grip is meant for what lies under it (a tab, a list row): it gets the click.
 */
function passTap(handle: HTMLElement, x: number, y: number): void {
  handle.style.pointerEvents = "none";
  const under = document.elementFromPoint(x, y);
  handle.style.pointerEvents = "";
  if (!under || handle.contains(under)) return;
  under.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 1 }));
}

function SplitHandle({ axis, handle }: { axis: Axis; handle: Handle }): ReactElement {
  const live = useApp((s) => s.conn.kind === "live");
  const ref = useRef<HTMLDivElement>(null);
  const grip = useRef<HTMLSpanElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [preview, setPreview] = useState<Preview | null>(null);
  const shown = useRef<Preview | null>(null);
  // Timers and pointer handlers act on the handle as last drawn.
  const current = useRef(handle);
  current.current = handle;

  useEffect(() => () => clearTimeout(keyTimer.current), []);

  // The limits the value is announced within: measured now and whenever the split or either side resizes.
  const [range, setRange] = useState<Range | null>(null);
  const limitsKey = handle.kind === "weight"
    ? `${handle.a.id} ${handle.a.min} ${handle.a.max} ${handle.b.id} ${handle.b.min} ${handle.b.max}`
    : `${handle.side.id} ${handle.sign} ${handle.side.min} ${handle.side.max} ${handle.side.collapsed}`;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (gesture.current) return;
      const r = rangeOf(el, axis, current.current);
      setRange((old) =>
        old && old.start === r.start && old.lo === r.lo && old.hi === r.hi && old.total === r.total ? old : r
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    for (const e of [el.parentElement, el.previousElementSibling, el.nextElementSibling]) if (e) watch.observe(e);
    return () => watch.disconnect();
  }, [axis, limitsKey]);

  // Positions along the split axis.
  const along = axis === "row" ? "clientX" : "clientY";
  const show = (p: Preview | null) => {
    shown.current = p;
    setPreview(p);
  };

  const begin = (pointer: number | null, from: number, onGrip: boolean): Gesture => ({
    ...rangeOf(ref.current!, axis, current.current),
    pointer,
    from,
    moved: false,
    grip: onGrip,
  });

  /** The preview for resized size `raw` (`snap`: a pointer drop may collapse). */
  const previewOf = (g: Gesture, raw: number, snap: boolean, cross: number | null): Preview => {
    const h = current.current;
    if (h.kind === "px" && snap && raw < g.snap) {
      return { size: h.side.rail, collapse: true, offset: h.sign * (h.side.rail - g.start), cross };
    }
    const size = Math.round(Math.min(g.hi, Math.max(g.lo, raw)));
    return { size, collapse: false, offset: (h.kind === "px" ? h.sign : 1) * (size - g.start), cross };
  };

  const commit = (g: Gesture, p: Preview) => {
    const h = current.current;
    if (h.kind === "weight") {
      if (Math.abs(p.size - g.start) < 1 || g.total <= 0) return;
      const sum = h.a.weight + h.b.weight || 2;
      // Weights to 4 decimals: the pair's ratio, their sum kept.
      const wa = Math.round(1e4 * sum * p.size / g.total) / 1e4;
      void bridge.setLayout([
        { node: h.a.id, size: { weight: wa } },
        { node: h.b.id, size: { weight: Math.max(0, Math.round(1e4 * (sum - wa)) / 1e4) } },
      ]);
      return;
    }
    const s = h.side;
    if (p.collapse) {
      if (!s.collapsed) void bridge.setLayout([{ node: s.id, collapsed: true }]);
    } else if (s.collapsed) {
      void bridge.setLayout([{ node: s.id, size: { px: p.size }, collapsed: false }]);
    } else if (Math.abs(p.size - g.start) >= 1) {
      void bridge.setLayout([{ node: s.id, size: { px: p.size } }]);
    }
  };

  const toggle = () => {
    const h = current.current;
    if (h.kind === "px" && h.side.collapsible) {
      void bridge.setLayout([{ node: h.side.id, collapsed: !h.side.collapsed }]);
    }
  };

  const cancel = () => {
    clearTimeout(keyTimer.current);
    const g = gesture.current;
    gesture.current = null;
    if (g?.pointer != null && ref.current?.hasPointerCapture(g.pointer)) ref.current.releasePointerCapture(g.pointer);
    show(null);
  };

  /** Sends what the arrow keys previewed (now, not after the pause). */
  const commitKeys = () => {
    clearTimeout(keyTimer.current);
    const g = gesture.current;
    const p = shown.current;
    if (!g || g.pointer !== null) return;
    gesture.current = null;
    show(null);
    if (p) commit(g, p);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!live || !e.isPrimary || e.button !== 0) return;
    commitKeys();
    // The press focuses the handle as any click does (Escape then cancels the drag; no focus ring for a pointer).
    e.currentTarget.setPointerCapture(e.pointerId);
    // On the grip: within its touch target (`app.css`: 44 px across the edge, 88 px along it).
    const r = grip.current?.getBoundingClientRect();
    const dx = r ? Math.abs(e.clientX - (r.left + r.width / 2)) : Infinity;
    const dy = r ? Math.abs(e.clientY - (r.top + r.height / 2)) : Infinity;
    const onGrip = (axis === "row" ? dx : dy) <= GRIP_HIT_PX && (axis === "row" ? dy : dx) <= GRIP_HIT_PX;
    gesture.current = begin(e.pointerId, e[along], onGrip);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    const delta = e[along] - g.from;
    if (!g.moved && Math.abs(delta) < DRAG_SLOP_PX) return;
    g.moved = true;
    const h = current.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const cross = axis === "row" ? e.clientY - rect.top : e.clientX - rect.left;
    show(previewOf(g, g.start + delta * (h.kind === "px" ? h.sign : 1), true, cross));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    gesture.current = null;
    const p = shown.current;
    show(null);
    if (g.moved) {
      if (p) commit(g, p);
    } else if (g.grip) {
      toggle();
    } else {
      passTap(e.currentTarget, e.clientX, e.clientY);
    }
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current?.pointer === e.pointerId) cancel();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const h = current.current;
    if (e.key === "Escape") {
      if (!gesture.current) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (!live || gesture.current?.pointer != null || systemKey(e)) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (h.kind === "px" && h.side.collapsible) {
        cancel();
        toggle();
      } else {
        commitKeys();
      }
      return;
    }
    const step = e.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown"
      ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp"
      ? -1
      : 0;
    if (dir === 0 && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    if (h.kind === "px" && h.side.collapsed) {
      // A rail opens first: to its kept size (toward it), or as large as it may be (End).
      const g = begin(null, 0, false);
      if (e.key === "End") {
        void bridge.setLayout([{ node: h.side.id, size: { px: Math.round(g.hi) }, collapsed: false }]);
      } else if (dir === h.sign) toggle();
      return;
    }
    const g = gesture.current ?? (gesture.current = begin(null, 0, false));
    const now = shown.current?.size ?? g.start;
    const raw = e.key === "Home" ? g.lo : e.key === "End" ? g.hi : now + dir * step * (h.kind === "px" ? h.sign : 1);
    show(previewOf(g, raw, false, null));
    clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(commitKeys, KEY_COMMIT_MS);
  };

  // The value: the px node's size, or the leading child's share of a weight pair (in %), within the measured limits.
  let now: number;
  let min: number;
  let max: number;
  let text: string;
  let value: string | null = null;
  if (handle.kind === "weight") {
    const g = gesture.current;
    const share = preview && g && g.total > 0
      ? preview.size / g.total
      : handle.a.weight / (handle.a.weight + handle.b.weight || 1);
    now = Math.round(share * 100);
    const total = range?.total ?? 0;
    min = Math.min(now, total > 0 ? Math.round(100 * range!.lo / total) : Math.round(100 * MIN_SHARE));
    max = Math.max(now, total > 0 ? Math.round(100 * range!.hi / total) : Math.round(100 * (1 - MIN_SHARE)));
    text = `${titleOf(handle.a.id)} ${now}%, ${titleOf(handle.b.id)} ${100 - now}%`;
    if (preview) value = `${now}% · ${100 - now}%`;
  } else {
    const s = handle.side;
    const collapsed = preview ? preview.collapse : s.collapsed;
    const lo = range?.lo ?? s.min ?? UNBOUNDED_MIN_PX;
    now = Math.round(preview?.size ?? (s.collapsed ? s.rail : s.px ?? range?.start ?? lo));
    // A rail is announced as the least value (it may be narrower than the drag limit of an unbounded panel).
    min = Math.min(now, s.collapsible ? Math.min(s.rail, lo) : lo);
    max = Math.max(now, Math.round(range?.hi ?? s.max ?? now));
    text = collapsed ? "Collapsed" : `${now} pixels`;
    if (preview) value = preview.collapse ? "Collapse" : `${preview.size}\u00a0px`;
  }

  const style = preview
    ? {
      ["--sep-offset" as string]: `${preview.offset}px`,
      ["--sep-cross" as string]: preview.cross === null ? "50%" : `${preview.cross}px`,
    } as CSSProperties
    : undefined;
  return (
    <div
      ref={ref}
      role="separator"
      className="sn-sep"
      tabIndex={0}
      aria-orientation={axis === "row" ? "vertical" : "horizontal"}
      aria-label={handle.label}
      aria-valuenow={now}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={text}
      aria-disabled={live ? undefined : true}
      data-rail={handle.kind === "px" && handle.side.collapsed ? (handle.sign === 1 ? "start" : "end") : undefined}
      data-active={preview ? "" : undefined}
      data-snap={preview?.collapse ? "" : undefined}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onKeyDown={onKeyDown}
      onBlur={commitKeys}
    >
      <span className="sn-sep__line" aria-hidden="true" />
      <span ref={grip} className="sn-sep__grip" aria-hidden="true" />
      {preview
        ? (
          <span className="sn-sep__guide" aria-hidden="true">
            <span className="sn-sep__value">{value}</span>
          </span>
        )
        : null}
    </div>
  );
}

/** Space kept between the shell button and the first item of a block bar made the leading row. */
const LEAD_GAP_PX = 8;

/**
 * A bar: a strip across a column (`--strip`, one line high) or a rail along a row. The leading bar is a row with the
 * shell button first. When that bar is a block bar (`--lead`: the mod draws the whole strip), the button's cell takes
 * the mod's background and bottom line, and the mod slides under the cell by as much of its own leading padding as it
 * can spare, so its first item starts {@link LEAD_GAP_PX} after the button, or where it already started when the mod
 * keeps room for macOS's window buttons there (Herdr's `terminals` bar).
 */
function Bar(
  { node, axis, look, segDepth }: { node: BarNode; axis: Axis; look: CSSProperties; segDepth: number },
): ReactElement {
  const ctx = useContext(ScreenContext);
  const leading = ctx.leadingBar === node.id;
  const lend = leading && node.axis !== "row";
  const dir = leading ? "row" : node.axis;
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const bar = ref.current;
    const block = bar?.querySelector<HTMLElement>(":scope > .sn-block");
    if (!lend || !bar || !block) return;
    const set = (name: string, value: string) => {
      if (bar.style.getPropertyValue(name) !== value) bar.style.setProperty(name, value);
    };
    const sync = () => {
      const root = block.querySelector<HTMLElement>(".r-view > .r-el");
      const s = root ? getComputedStyle(root) : null;
      const button = bar.querySelector<HTMLElement>(":scope > .shell-button")?.offsetWidth ?? 0;
      const spare = s ? parseFloat(s.paddingLeft) - LEAD_GAP_PX : 0;
      const line = s && parseFloat(s.borderBottomWidth) > 0
        ? `inset 0 -${s.borderBottomWidth} ${s.borderBottomColor}`
        : "none";
      set("--lead-bg", s?.backgroundColor ?? "transparent");
      set("--lead-line", line);
      set("--lead-shift", `${Math.min(Math.max(0, spare), button)}px`);
    };
    sync();
    // The mod's tree arrives and changes after this render (first paint, theme switches).
    const watch = new MutationObserver(sync);
    watch.observe(block, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
    return () => watch.disconnect();
  }, [lend]);

  const classes = ["sn-bar"];
  if (axis === "column") classes.push("sn-bar--strip");
  if (lend) classes.push("sn-bar--lead");
  return (
    <div
      ref={ref}
      className={classes.join(" ")}
      data-axis={dir}
      data-node={node.id}
      style={{ flex: `0 0 ${node.px}px`, [axis === "row" ? "width" : "height"]: node.px, ...look }}
    >
      {leading ? <ShellButton /> : null}
      {node.children.map((c) => <ScreenView key={c.id} node={c} axis={dir} segDepth={segDepth} />)}
    </div>
  );
}

function LinkRow({ id, route }: { id: string; route: string }): ReactElement {
  const open = useApp((s) => (s.optimistic ?? s.graph)?.stack.includes(route) ?? false);
  return (
    <button
      type="button"
      className="sn-link"
      data-node={id}
      aria-expanded={open}
      onClick={() => void bridge.nav({ action: "push", route })}
    >
      <span className="sn-link__label">{titleOf(route.slice(1) || id)}</span>
      <Icon name="forward" size={18} />
    </button>
  );
}

function Group(
  { node, style, look, segDepth }: { node: GroupNode; style: CSSProperties; look: CSSProperties; segDepth: number },
): ReactElement {
  const [moreOpen, setMoreOpen] = useState(false);
  const active = node.destinations.find((d) => d.id === node.active) ?? node.destinations[0];
  const segments = node.nav === "segments";
  const select = (child: string) => {
    setMoreOpen(false);
    if (child !== node.active) void bridge.nav({ action: "select", stack: node.id, child });
  };
  const body = (
    <div className="sn-group__body" style={look}>
      {active.mounted
        ? <ScreenView node={active.screen} axis="column" segDepth={segments ? segDepth + 1 : segDepth} />
        : <div className="sn-hidden">{`${titleOf(active.id)} is hidden on the Mac`}</div>}
    </div>
  );
  if (!segments) {
    return <div className="sn-group" data-node={node.id} style={style}>{body}</div>;
  }
  const placement = segDepth === 0 ? "bottom" : "top";
  // Layout ids double as titles (`work`): shown as words in the text itself, so the visible label and the accessible
  // name agree (WCAG 2.5.3), not capitalised by CSS.
  const title = (id: string) => titleOf(node.destinations.find((d) => d.id === id)?.title || id);
  const moreActive = node.more.includes(node.active);
  const control = (
    <nav className="segments" data-placement={placement} aria-label={`${titleOf(node.id)} sections`}>
      {node.shown.map((id) => (
        <button
          key={id}
          type="button"
          className="segments__item"
          aria-current={id === node.active ? "page" : undefined}
          onClick={() => select(id)}
        >
          <span className="segments__label">{title(id)}</span>
        </button>
      ))}
      {node.more.length
        ? (
          <button
            type="button"
            className="segments__item segments__item--more"
            aria-current={moreActive ? "page" : undefined}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
          >
            <span className="segments__label">{moreActive ? title(node.active) : "More"}</span>
            <Icon name="up" size={14} />
          </button>
        )
        : null}
    </nav>
  );
  return (
    <div className="sn-group sn-group--segments" data-node={node.id} data-placement={placement} style={style}>
      {placement === "top" ? control : null}
      {body}
      {placement === "bottom" ? control : null}
      {moreOpen
        ? (
          <Sheet side="bottom" label={`More in ${titleOf(node.id)}`} title="More" onClose={() => setMoreOpen(false)}>
            <ul className="list" role="list">
              {node.more.map((id, i) => (
                <li key={id}>
                  <button
                    type="button"
                    className="list__row"
                    aria-current={id === node.active ? "page" : undefined}
                    data-autofocus={i === 0 ? "" : undefined}
                    onClick={() => select(id)}
                  >
                    <span className="list__label">{title(id)}</span>
                    {id === node.active ? <Icon name="check" size={18} /> : null}
                  </button>
                </li>
              ))}
            </ul>
          </Sheet>
        )
        : null}
    </div>
  );
}

const NO_PANES: readonly PaneInfo[] = [];

/** The panes of the tab this session shows (its focus; else the active tab of the active space). */
function useShownPanes(): readonly PaneInfo[] {
  const live = useApp((s) => s.live);
  return useMemo(() => {
    if (!live) return NO_PANES;
    const tab = live.focused?.tab ?? live.spaces.find((s) => s.active)?.tabs.find((t) => t.active)?.id;
    return tab ? live.panes.filter((p) => p.tab === tab) : NO_PANES;
  }, [live]);
}

function PaneBody({ pane }: { pane: PaneInfo }): ReactElement {
  if (pane.terminal) return renderTerminal({ id: pane.pane, terminal: pane.terminal });
  return (
    <div className="slot-placeholder" role="img" aria-label={`Mod pane ${pane.mod ?? pane.pane}`}>
      <span className="slot-placeholder__label" translate="no">{`mod pane · ${pane.mod ?? pane.pane}`}</span>
      <span className="slot-placeholder__status">{pane.title}</span>
    </div>
  );
}

function Panes({ node, style }: { node: PanesNode; style: CSSProperties }): ReactElement {
  const panes = useShownPanes();
  const focusedPane = useApp((s) => s.live?.focused?.pane ?? null);
  const ctx = useContext(ScreenContext);
  const paneLook = ctx.index.get(node.id)?.content as { pane?: LayoutNode } | undefined;
  const cardLook = lookStyle(paneLook?.pane);
  const header = node.header;
  const pager = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);

  // Show the focused pane when focus moves (a tapped notification, `pane.focus` from a mod).
  useEffect(() => {
    const el = pager.current;
    const i = panes.findIndex((p) => p.pane === focusedPane);
    if (!el || i < 0) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "instant" });
    setPage(i);
  }, [focusedPane, panes]);

  if (panes.length === 0) {
    return (
      <div className="sn-panes sn-panes--empty" data-node={node.id} style={style}>
        <div className="sn-hidden">No panes in this tab</div>
      </div>
    );
  }

  const card = (p: PaneInfo) => (
    <section key={p.pane} className="sn-pane" style={cardLook} aria-label={p.title || p.pane}>
      {header && header.position === "top"
        ? (
          <div className="sn-pane__header" style={{ height: header.height }}>
            {renderView(`${header.folder}:pane:${p.pane}`)}
          </div>
        )
        : null}
      <div className="sn-pane__body">
        <PaneBody pane={p} />
      </div>
      {header && header.position === "bottom"
        ? (
          <div className="sn-pane__header" style={{ height: header.height }}>
            {renderView(`${header.folder}:pane:${p.pane}`)}
          </div>
        )
        : null}
    </section>
  );

  if (node.mode === "split") {
    return <div className="sn-panes sn-panes--split" data-node={node.id} style={style}>{panes.map(card)}</div>;
  }

  const onScroll = () => {
    const el = pager.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
    if (i !== page) setPage(i);
  };
  const onSettle = () => {
    const p = panes[page];
    // Paging is local; telling the session which pane is shown is best effort (no toast on refusal). `pane.focus` is
    // session-class, so read-only devices send it too.
    if (p && p.pane !== focusedPane) {
      void bridge.request({ t: "command", name: "pane.focus", args: { pane: p.pane } });
    }
  };
  return (
    <div className="sn-panes sn-panes--pager" data-node={node.id} style={style}>
      <div className="sn-pager" ref={pager} onScroll={onScroll} onScrollEnd={onSettle} tabIndex={0} aria-label="Panes">
        {panes.map(card)}
      </div>
      {panes.length > 1
        ? (
          <div className="sn-pager__dots" aria-label={`Pane ${page + 1} of ${panes.length}`} role="status">
            {panes.map((p, i) => <span key={p.pane} className="sn-pager__dot" data-on={i === page || undefined} />)}
          </div>
        )
        : null}
    </div>
  );
}
