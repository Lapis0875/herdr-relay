/**
 * `h_resizable(id)` / `v_resizable(id)`: panels along one axis with draggable dividers. A panel starts at its
 * `size(px)` (recorded as its width or height), panels without one share what is left. A divider moves by a pointer
 * drag (mouse, pen or finger: on touch screens it has a 44 px hit area and a grip) or, focused, by the arrow keys
 * (10 px; Shift: 50 px) and Home/End (as far as it goes), keeping both neighbours within their `size_range(min, max?)`
 * (minimum 100 px unless given, as in Base); when a move ends the group's `on_resize` hears every panel's size. A
 * finger that sets off across the axis scrolls the page instead (`touch-action`), and the divider goes back.
 *
 * Sizes are this device's, as Herdr keeps them per window: in `localStorage` per layout (the one on screen now, from
 * the ScreenGraph), view and group id (`splitStore.ts`), so they survive re-renders, coming back to the view and
 * reloads; sizes kept for a different number of panels are ignored. Every render draws them within the panels'
 * current `size_range`, so a mod narrowing a range moves the divider at once; the size the person chose is kept, and
 * comes back if the range widens again (as it would on a reload).
 */

import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { ElementNode } from "@herdr-relay/protocol";
import { shownGraph, useApp } from "../app/store.ts";
import { RenderContext } from "../render/context.ts";
import type { WidgetProps } from "../render/widgets.tsx";
import { loadSplit, saveSplit, splitKey, type SplitSizes, touchSplit } from "./splitStore.ts";

/** Base's own minimum panel size (px). */
const DEFAULT_MIN = 100;
const KEY_STEP = 10;
const SHIFT_KEY_STEP = 50;
/** How far (px) a finger or pen moves along the axis before the divider follows: a tap or a scroll moves nothing. */
const TOUCH_SLOP = 6;

interface Panel {
  size: number | null;
  min: number;
  max: number;
}

const ANY_PANEL: Panel = { size: null, min: DEFAULT_MIN, max: Infinity };

function panelOf(child: ElementNode | undefined, horizontal: boolean): Panel {
  const s = child?.style ?? {};
  const size = horizontal ? s.width : s.height;
  const range = child?.attrs?.size_range;
  const [min, max] = Array.isArray(range) ? range : typeof range === "number" ? [range] : [];
  return {
    size: typeof size === "number" && size >= 0 ? size : null,
    min: typeof min === "number" && min >= 0 ? min : DEFAULT_MIN,
    max: typeof max === "number" && max > 0 ? max : Infinity,
  };
}

/** Where panel `i` may be (px) while it and panel `i + 1` share `total`; `[lo, hi]` with `hi < lo` when nowhere. */
function rangeOf(panels: readonly Panel[], i: number, total: number): [number, number] {
  const p = panels[i] ?? ANY_PANEL;
  const q = panels[i + 1] ?? ANY_PANEL;
  return [Math.max(p.min, total - q.max, 0), Math.min(p.max, total - q.min)];
}

/** The sizes this device kept for the group (a flexible one taking the mod's size, if it now has one); else the mod's. */
function restore(key: string, panels: readonly Panel[]): SplitSizes {
  const kept = loadSplit(key, panels.length);
  return kept ? kept.map((s, i) => s ?? panels[i]?.size ?? null) : panels.map((p) => p.size);
}

/** `sizes` within the panels' current ranges; `sizes` itself when every one already is (unchanged sizes stay). */
function withinRanges(sizes: SplitSizes, panels: readonly Panel[]): SplitSizes {
  let out: (number | null)[] | null = null;
  sizes.forEach((s, i) => {
    const p = panels[i] ?? ANY_PANEL;
    const drawn = s === null ? null : Math.min(p.max, Math.max(p.min, s));
    if (drawn !== s) (out ??= [...sizes])[i] = drawn;
  });
  return out ?? sizes;
}

interface Drag {
  pointer: number;
  /** The divider's left/upper panel. */
  index: number;
  from: number;
  a: number;
  b: number;
  before: SplitSizes;
  /** The divider follows the pointer: a mouse at once, a finger or pen past {@link TOUCH_SLOP}. */
  following: boolean;
}

export function Resizable({ node, dom, children }: WidgetProps): ReactElement {
  const env = useContext(RenderContext);
  // The layout on screen now: `hello.layout` is only the one the connection started with.
  const layout = useApp((s) => shownGraph(s)?.layout ?? "");
  const horizontal = node.tag !== "v_resizable";
  const panels = (node.children ?? []).map((c) => panelOf(c, horizontal));
  const count = children.length;
  const key = splitKey(layout, env.view, node.id ?? node.widget.state);
  // Another group (layout, view or id) or another panel count starts over from what is kept for it.
  const shape = `${panels.length} ${key}`;
  const [kept, setKept] = useState(() => ({ shape, sizes: restore(key, panels) }));
  let chosen = kept.sizes;
  if (kept.shape !== shape) {
    chosen = restore(key, panels);
    setKept({ shape, sizes: chosen });
  }
  const sizes = withinRanges(chosen, panels);
  const current = useRef(sizes);
  current.current = sizes;
  /** Every panel's laid-out size (px), flexible ones included: the dividers' `aria-value*`. */
  const [measured, setMeasured] = useState<readonly number[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const wrappers = useRef<(HTMLDivElement | null)[]>([]);
  const drag = useRef<Drag | null>(null);
  /** The sizes before the keys being pressed on a divider moved it. */
  const keyed = useRef<SplitSizes | null>(null);
  const ids = useId();
  const resize = typeof node.on?.resize === "number" ? node.on.resize : undefined;

  useEffect(() => touchSplit(key), [key]);

  const measure = (i: number) => {
    const r = wrappers.current[i]?.getBoundingClientRect();
    return r ? (horizontal ? r.width : r.height) : 0;
  };

  useEffect(() => {
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      const next = Array.from({ length: count }, (_, i) => Math.round(measure(i)));
      setMeasured((m) => (m.length === next.length && m.every((v, i) => v === next[i]) ? m : next));
    });
    for (const el of wrappers.current.slice(0, count)) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [count, horizontal]);

  const set = (next: SplitSizes) => {
    current.current = next;
    setKept({ shape, sizes: next });
  };

  /** Moves divider `i` so panel `i` is `a + delta` px (its neighbour giving or taking the difference). */
  const move = (i: number, a: number, b: number, delta: number) => {
    const [lo, hi] = rangeOf(panels, i, a + b);
    const next = Math.round(hi < lo ? a : Math.min(hi, Math.max(lo, a + delta)));
    const out = Array.from({ length: count }, (_, k) => current.current[k] ?? null);
    if (out[i] === null && out[i + 1] !== null) {
      // The flexible panel keeps taking whatever is left.
      out[i + 1] = a + b - next;
    } else {
      out[i] = next;
      if (out[i + 1] !== null) out[i + 1] = a + b - next;
    }
    set(out);
  };

  /** A move ended: changed sizes are kept for this device, and `on_resize` hears every panel's laid-out size. */
  const finish = (before: SplitSizes) => {
    const after = current.current;
    if (after.length !== before.length || after.some((v, i) => v !== before[i])) saveSplit(key, after);
    const send = env.send;
    if (resize === undefined || !send) return;
    requestAnimationFrame(() => {
      send(resize, "size", { sizes: Array.from({ length: count }, (_, i) => Math.round(measure(i))) });
    });
  };

  const onPointerDown = (i: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      pointer: e.pointerId,
      index: i,
      from: horizontal ? e.clientX : e.clientY,
      a: measure(i),
      b: measure(i + 1),
      before: current.current,
      following: e.pointerType === "mouse",
    };
    setDragging(i);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    const delta = (horizontal ? e.clientX : e.clientY) - d.from;
    if (!d.following && Math.abs(delta) < TOUCH_SLOP) return;
    d.following = true;
    move(d.index, d.a, d.b, delta);
  };
  /** `pointerup` ends the move; `pointercancel` (the browser took the finger to scroll or zoom) undoes it. */
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    setDragging(null);
    if (e.type === "pointercancel") set(d.before);
    else finish(d.before);
  };

  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    const back = horizontal ? "ArrowLeft" : "ArrowUp";
    const forward = horizontal ? "ArrowRight" : "ArrowDown";
    let delta: number;
    if (e.key === back || e.key === forward) {
      delta = (e.shiftKey ? SHIFT_KEY_STEP : KEY_STEP) * (e.key === back ? -1 : 1);
    } else if (e.key === "Home" || e.key === "End") {
      delta = e.key === "Home" ? -Infinity : Infinity;
    } else {
      return;
    }
    e.preventDefault();
    keyed.current ??= current.current;
    move(i, measure(i), measure(i + 1), delta);
  };
  /** The keys that moved a divider were let go (or focus left it): the move ended. */
  const onKeyEnd = () => {
    const before = keyed.current;
    if (!before) return;
    keyed.current = null;
    finish(before);
  };

  const parts: ReactElement[] = [];
  children.forEach((child, i) => {
    if (i > 0) {
      const k = i - 1;
      const a = measured[k];
      const b = measured[i];
      let value: { now?: number; min: number; max?: number };
      if (a === undefined || b === undefined) {
        // Not laid out yet (or no browser): the panel's own size and range.
        const p = panels[k] ?? ANY_PANEL;
        value = { now: sizes[k] ?? undefined, min: p.min, max: Number.isFinite(p.max) ? p.max : undefined };
      } else {
        const [lo, hi] = rangeOf(panels, k, a + b);
        value = hi < lo
          ? { now: a, min: a, max: a }
          : { now: a, min: Math.round(Math.min(lo, a)), max: Math.round(Math.max(hi, a)) };
      }
      parts.push(
        <div
          key={`handle-${i}`}
          className="w-resizable__handle"
          role="separator"
          aria-orientation={horizontal ? "vertical" : "horizontal"}
          aria-controls={`${ids}-${k}`}
          aria-valuenow={value.now}
          aria-valuemin={value.min}
          aria-valuemax={value.max}
          aria-valuetext={value.now === undefined ? undefined : `${value.now} pixels`}
          aria-label={count > 2 ? `Resize panels ${i} and ${i + 1}` : "Resize panels"}
          data-dragging={dragging === k ? "" : undefined}
          tabIndex={0}
          onPointerDown={onPointerDown(k)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={onKeyDown(k)}
          onKeyUp={onKeyEnd}
          onBlur={onKeyEnd}
        />,
      );
    }
    const size = sizes[i] ?? null;
    parts.push(
      <div
        key={`panel-${i}`}
        id={`${ids}-${i}`}
        ref={(el) => {
          wrappers.current[i] = el;
        }}
        className="w-resizable__panel"
        style={{ flex: size === null ? "1 1 0" : `0 0 ${size}px` }}
      >
        {child}
      </div>,
    );
  });

  return (
    <div
      {...dom}
      className={`${dom.className} w-resizable`}
      data-axis={horizontal ? "x" : "y"}
      data-resizing={dragging === null ? undefined : ""}
    >
      {parts}
    </div>
  );
}
