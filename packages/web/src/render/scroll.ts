/**
 * Scroll handles on a device. The tree keeps the tracked handle's latest request on the element (`scrollTo`, protocol
 * `ScrollRequest`); once per request (`gen` + `seq`: `seq` counts in one mod host process, `gen` names the process),
 * after layout, the element carries it out. A plain element (`ScrollHandle`) reveals direct child `index` (`bottom`:
 * its last child) with the smallest scroll — CSS `nearest`, as `scrollIntoView({block: "nearest", inline: "nearest"})`
 * would — or centres it (`strategy: "center"`), but only on the axes it scrolls and only itself: GPUI moves the
 * tracked area alone, never the page or an outer scroller. A child already in view stays put; an index past the
 * children does nothing. Virtual lists (`VirtualListScrollHandle`) use {@link useScrollRequest} with their own row
 * offsets (`widgets/VirtualList.tsx`).
 */

import { type RefObject, useLayoutEffect, useRef } from "react";
import type { ElementNode } from "@herdr-relay/protocol";

/** The axes an element scrolls (`overflow_*_scroll`/`_scrollbar`: `overflowX`/`overflowY` `auto` or `scroll`). */
export interface ScrollAxes {
  x: boolean;
  y: boolean;
}

export function scrollAxes(style: ElementNode["style"] | undefined): ScrollAxes {
  const x = style?.overflowX;
  const y = style?.overflowY;
  return { x: x === "auto" || x === "scroll", y: y === "auto" || y === "scroll" };
}

/** A request as a device carries it out: its identity, the item (`"end"` for `bottom`) and whether to centre it. */
export interface ScrollTarget {
  /** `seq` within `gen` (the mod host process): carried out once. */
  seq: number;
  gen?: string;
  item: number | "end";
  center: boolean;
}

const isIndex = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** `node.scrollTo` as a {@link ScrollTarget}; `null` when there is none or it is malformed. */
export function scrollTarget(request: unknown): ScrollTarget | null {
  if (typeof request !== "object" || request === null || !("seq" in request) || !isIndex(request.seq)) return null;
  const id: Pick<ScrollTarget, "seq" | "gen"> = { seq: request.seq };
  if ("gen" in request && typeof request.gen === "string") id.gen = request.gen;
  if ("bottom" in request) return request.bottom === true ? { ...id, item: "end", center: false } : null;
  if (!("index" in request) || !isIndex(request.index)) return null;
  const center = "strategy" in request && request.strategy === "center";
  return { ...id, item: request.index, center };
}

/**
 * How far to scroll so that `[a, b]` (the child, on one axis) shows inside `[start, end]` (the scrollport), CSSOM
 * "scroll an element into view" with `nearest`: 0 when it is inside or covers the scrollport; else the edge that is
 * out aligns with the scrollport's, the near one when the child fits and the far one when it does not.
 */
export function nearestDelta(a: number, b: number, start: number, end: number): number {
  const fits = b - a <= end - start;
  if (a < start && b > end) return 0;
  if ((a < start && fits) || (b > end && !fits)) return a - start;
  if ((a < start && !fits) || (b > end && fits)) return b - end;
  return 0;
}

/** {@link nearestDelta}, or with `center` how far to scroll so that the middles of `[a, b]` and the port meet. */
export function alignDelta(a: number, b: number, start: number, end: number, center: boolean): number {
  return center ? (a + b - start - end) / 2 : nearestDelta(a, b, start, end);
}

/** Scrolls `box` so that `child` shows in its scrollport on `axes`: the smallest amount, or centred. */
export function revealChild(box: HTMLElement, child: Element, axes: ScrollAxes, center = false): void {
  // A child without a box of its own (`display: contents`, `none`) has no place to reveal.
  if (child.getClientRects().length === 0) return;
  const port = box.getBoundingClientRect();
  const r = child.getBoundingClientRect();
  if (axes.x) {
    const start = port.left + box.clientLeft;
    const dx = alignDelta(r.left, r.right, start, start + box.clientWidth, center);
    if (dx !== 0) box.scrollLeft += dx;
  }
  if (axes.y) {
    const start = port.top + box.clientTop;
    const dy = alignDelta(r.top, r.bottom, start, start + box.clientHeight, center);
    if (dy !== 0) box.scrollTop += dy;
  }
}

/**
 * Runs `apply` with `node.scrollTo` once per request (`gen` + `seq`), in the layout phase of the commit that brings
 * it (the `apply` of that render, so it sees that render's layout data).
 */
export function useScrollRequest(node: ElementNode, apply: (target: ScrollTarget) => void): void {
  const target = scrollTarget(node.scrollTo);
  const applied = useRef<string | null>(null);
  const key = target === null ? null : `${target.seq}@${target.gen ?? ""}`;
  useLayoutEffect(() => {
    if (target === null || applied.current === key) return;
    applied.current = key;
    apply(target);
    // Only a new request runs again; its render's `target` and `apply` are the current ones.
  }, [key]);
}

/**
 * A plain element's request: `skip` is how many element children `el` draws before the node's children (slots), or
 * `null` when its children are not the node's (a widget, `frames`): then nothing is revealed.
 */
export function useScrollTo(el: RefObject<HTMLElement | null>, node: ElementNode, skip: number | null): void {
  const { x, y } = scrollAxes(node.style);
  const count = Array.isArray(node.children) ? node.children.length : 0;
  useScrollRequest(node, ({ item, center }) => {
    const box = el.current;
    const index = item === "end" ? count - 1 : item;
    if (!box || skip === null || (!x && !y) || index < 0 || index >= count) return;
    const child = box.children.item(skip + index);
    if (child) revealChild(box, child, { x, y }, center);
  });
}
