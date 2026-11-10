/**
 * `v_virtual_list` / `h_virtual_list` / `list` / `uniform_list`: client windowing over the rows the host recorded.
 * Only the rows in view (plus {@link OVERSCAN} each side) are mounted, at offsets from `props.sizes` (one size for
 * every row, or one per row; px along the list's axis). The host records the first rows only (`LIST_WINDOW` in the
 * mod host); when `props.count` says there are more, a note at the end says how many are not shown.
 *
 * A press on a row reports its key (`on_item_click`; a right press or a touch long press `on_item_secondary_click`).
 * Rows of a list with an item handler are focusable; Enter or Space presses them.
 */

import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { JsonValue } from "@herdr-relay/protocol";
import { RenderContext } from "../render/context.ts";
import { claim, imeKey, modifiersOf, systemKey } from "../render/events.ts";
import type { WidgetProps } from "../render/widgets.tsx";

/** Rows mounted beyond each edge of the view. */
const OVERSCAN = 6;
/** Row size when the host gave none (px). */
const DEFAULT_SIZE = 28;
const LONG_PRESS_MS = 500;

/** One size per row along `axis`. */
function sizesOf(v: JsonValue | undefined, n: number, horizontal: boolean): number[] {
  const one = (s: JsonValue | undefined): number | undefined => {
    if (typeof s === "number" && s > 0) return s;
    if (typeof s === "object" && s !== null && !Array.isArray(s)) {
      const d = horizontal ? s.width : s.height;
      if (typeof d === "number" && d > 0) return d;
    }
    return undefined;
  };
  if (Array.isArray(v)) {
    const last = one(v.at(-1)) ?? DEFAULT_SIZE;
    return Array.from({ length: n }, (_, i) => one(v[i]) ?? last);
  }
  return new Array<number>(n).fill(one(v) ?? DEFAULT_SIZE);
}

/** The first index whose row ends after `pos`. */
function rowAt(offsets: number[], pos: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const numberFormat = new Intl.NumberFormat();

export function VirtualList({ node, dom, children }: WidgetProps): ReactElement {
  const env = useContext(RenderContext);
  const p = node.widget.props ?? {};
  const horizontal = node.tag === "h_virtual_list";
  const keys = Array.isArray(p.keys) ? p.keys : [];
  const n = children.length;
  const count = typeof p.count === "number" && p.count > n ? Math.floor(p.count) : n;
  const sizes = useMemo(() => sizesOf(p.sizes, n, horizontal), [p.sizes, n, horizontal]);
  const offsets = useMemo(() => {
    const out = [0];
    for (const s of sizes) out.push(out[out.length - 1] + s);
    return out;
  }, [sizes]);
  const item = typeof node.on?.item === "number" ? node.on.item : undefined;
  const secondary = typeof node.on?.itemsecondary === "number" ? node.on.itemsecondary : undefined;

  const scroller = useRef<HTMLElement | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    scroller.current = el;
    dom.ref(el);
  }, [dom.ref]);
  const [range, setRange] = useState({ start: 0, end: Math.min(n, 40) });

  // The window follows scrolling and the list's own size.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const pos = horizontal ? el.scrollLeft : el.scrollTop;
      const extent = horizontal ? el.clientWidth : el.clientHeight;
      const start = Math.max(0, rowAt(offsets, pos) - OVERSCAN);
      const end = Math.min(n, rowAt(offsets, pos + extent) + 1 + OVERSCAN);
      setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
    };
  }, [offsets, n, horizontal]);

  /** The key of the row an event happened in (rows of nested lists belong to those lists). */
  const rowKey = (container: HTMLElement, target: EventTarget | null): string | null => {
    const row = target instanceof Element ? target.closest<HTMLElement>(".w-vlist__row") : null;
    if (!row || row.parentElement?.parentElement !== container) return null;
    const key = keys[Number(row.dataset.index)];
    return typeof key === "string" ? key : null;
  };

  const press = (key: string, e: MouseEvent | KeyboardEvent, count: number) => {
    if (item !== undefined) env.send?.(item, "click", { click_count: count, modifiers: modifiersOf(e), key });
  };

  const secondaryPress = (key: string, e: { clientX: number; clientY: number }, el: HTMLElement) => {
    if (secondary === undefined) return;
    const r = el.getBoundingClientRect();
    env.send?.(secondary, "mousedown", {
      button: "right",
      click_count: 1,
      position: { x: e.clientX, y: e.clientY },
      local_position: { x: e.clientX - r.left, y: e.clientY - r.top },
      bounds: { x: r.left, y: r.top, width: r.width, height: r.height },
      modifiers: { shift: false, control: false, alt: false, platform: false, function: false },
      key,
    });
  };

  // A touch long press is the secondary press.
  const longPress = useRef<{ timer?: ReturnType<typeof setTimeout>; fired: boolean }>({ fired: false });

  const rows: ReactElement[] = [];
  for (let i = range.start; i < Math.min(range.end, n); i++) {
    const at = offsets[i];
    const size = sizes[i];
    const key = keys[i];
    rows.push(
      <div
        key={typeof key === "string" ? `k:${key}` : `i:${i}`}
        className="w-vlist__row"
        data-index={i}
        role={dom.role ? undefined : "listitem"}
        tabIndex={item !== undefined ? 0 : undefined}
        style={horizontal ? { left: at, width: size } : { top: at, height: size }}
        onKeyDown={item === undefined ? undefined : (e) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          if (imeKey(e) || systemKey(e)) return;
          e.preventDefault();
          if (typeof key === "string" && claim(e.nativeEvent, "item")) press(key, e, 1);
        }}
      >
        {children[i]}
      </div>,
    );
  }

  return (
    <div
      {...dom}
      ref={ref}
      className={`${dom.className} w-vlist`}
      data-axis={horizontal ? "x" : "y"}
      role={dom.role ?? "list"}
      aria-rowcount={count > n ? count : undefined}
      onClick={(e) => {
        dom.onClick?.(e);
        if (longPress.current.fired) {
          longPress.current.fired = false;
          return;
        }
        const key = item === undefined ? null : rowKey(e.currentTarget, e.target);
        if (key !== null && claim(e.nativeEvent, "item")) press(key, e, Math.max(1, e.detail));
      }}
      onContextMenu={secondary === undefined ? dom.onContextMenu : (e) => {
        const key = rowKey(e.currentTarget, e.target);
        if (key === null) return;
        e.preventDefault();
        if (claim(e.nativeEvent, "itemsecondary")) secondaryPress(key, e, e.currentTarget);
      }}
      onPointerDown={(e) => {
        dom.onPointerDown?.(e);
        clearTimeout(longPress.current.timer);
        if (secondary === undefined || e.pointerType === "mouse") return;
        const key = rowKey(e.currentTarget, e.target);
        if (key === null) return;
        const target = e.currentTarget;
        const at = { clientX: e.clientX, clientY: e.clientY };
        longPress.current = {
          fired: false,
          timer: setTimeout(() => {
            longPress.current.fired = true;
            secondaryPress(key, at, target);
          }, LONG_PRESS_MS),
        };
      }}
      onPointerUp={(e) => {
        dom.onPointerUp?.(e);
        clearTimeout(longPress.current.timer);
      }}
      onPointerCancel={(e) => {
        dom.onPointerCancel?.(e);
        clearTimeout(longPress.current.timer);
      }}
    >
      <div
        className="w-vlist__spacer"
        style={horizontal ? { width: offsets[n], height: "100%" } : { height: offsets[n] }}
      >
        {rows}
      </div>
      {count > n
        ? (
          <div className="w-vlist__more" role="note">
            {`Showing the first ${numberFormat.format(n)} of ${numberFormat.format(count)} rows`}
          </div>
        )
        : null}
    </div>
  );
}
