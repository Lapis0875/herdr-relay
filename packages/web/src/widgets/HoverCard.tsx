/**
 * `HoverCard`: the `trigger` slot in place, the `content` slot in a card above everything else once the pointer has
 * rested on the trigger for `open_delay` ms (default 600) or the keyboard focus moved into it. It closes
 * `close_delay` ms (default 300) after the pointer left both trigger and card — the time to cross the gap — or when
 * focus leaves, or on Escape. Touch screens have no hover: a long press on the trigger opens it (without also
 * pressing the trigger), a press anywhere else closes it. `anchor` names the card's edge pinned to the trigger
 * (default `top_center`: below the trigger, centred); the card is kept inside the window, flipping to the other side
 * when it does not fit.
 */

import {
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { JsonValue } from "@herdr-relay/protocol";
import type { WidgetProps } from "../render/widgets.tsx";

const OPEN_DELAY_MS = 600;
const CLOSE_DELAY_MS = 300;
const LONG_PRESS_MS = 500;
/** Space between the trigger and the card, and the card and the window edge (px). */
const GAP = 6;
const MARGIN = 8;

const ms = (v: JsonValue | undefined, fallback: number) =>
  typeof v === "number" && v >= 0 && v <= 10_000 ? v : fallback;

/** Where the card goes for `anchor`, kept inside the viewport. */
function place(anchor: string, t: DOMRect, w: number, h: number): { left: number; top: number } {
  const below = !anchor.startsWith("bottom");
  let top = below ? t.bottom + GAP : t.top - GAP - h;
  if (below && top + h > innerHeight - MARGIN && t.top - GAP - h >= MARGIN) top = t.top - GAP - h;
  if (!below && top < MARGIN && t.bottom + GAP + h <= innerHeight - MARGIN) top = t.bottom + GAP;
  let left = anchor.endsWith("left") ? t.left : anchor.endsWith("right") ? t.right - w : t.left + t.width / 2 - w / 2;
  left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, innerWidth - MARGIN - w));
  top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, innerHeight - MARGIN - h));
  return { left, top };
}

export function HoverCard({ node, dom, children, slots }: WidgetProps): ReactElement {
  const attrs = node.attrs ?? {};
  const openDelay = ms(attrs.open_delay, OPEN_DELAY_MS);
  const closeDelay = ms(attrs.close_delay, CLOSE_DELAY_MS);
  const anchor = typeof attrs.anchor === "string" ? attrs.anchor : "top_center";
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const root = useRef<HTMLElement | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; opened: boolean }>({ opened: false });
  const id = useId();
  const ref = useCallback((el: HTMLElement | null) => {
    root.current = el;
    dom.ref(el);
  }, [dom.ref]);

  const later = (next: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  };
  const hold = () => clearTimeout(timer.current);

  useEffect(() => () => {
    clearTimeout(timer.current);
    clearTimeout(press.current.timer);
  }, []);

  // Position once open, and whenever the page scrolls or resizes under it.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const t = root.current?.getBoundingClientRect();
      const c = card.current;
      if (t && c) setPos(place(anchor, t, c.offsetWidth, c.offsetHeight));
    };
    update();
    addEventListener("scroll", update, true);
    addEventListener("resize", update);
    return () => {
      removeEventListener("scroll", update, true);
      removeEventListener("resize", update);
    };
  }, [open, anchor]);

  // While open: Escape closes; on touch, a press outside closes.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const outside = (e: Event) => {
      const target = e.target as Node;
      if (!root.current?.contains(target) && !card.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open]);

  const hover = (e: PointerEvent, inside: boolean) => {
    if (e.pointerType === "touch") return;
    if (inside) later(true, open ? 0 : openDelay);
    else later(false, closeDelay);
  };

  const content = slots.content ?? null;
  return (
    <div
      {...dom}
      ref={ref}
      className={`${dom.className} w-hovercard`}
      aria-describedby={open && content ? id : undefined}
      onPointerEnter={(e) => {
        dom.onPointerEnter?.(e);
        hover(e, true);
      }}
      onPointerLeave={(e) => {
        dom.onPointerLeave?.(e);
        hover(e, false);
      }}
      onPointerDown={(e) => {
        dom.onPointerDown?.(e);
        if (e.pointerType !== "touch") return;
        clearTimeout(press.current.timer);
        press.current = {
          opened: false,
          timer: setTimeout(() => {
            press.current.opened = true;
            setOpen(true);
          }, LONG_PRESS_MS),
        };
      }}
      onPointerUp={(e) => {
        dom.onPointerUp?.(e);
        clearTimeout(press.current.timer);
      }}
      onPointerCancel={(e) => {
        dom.onPointerCancel?.(e);
        clearTimeout(press.current.timer);
      }}
      onClickCapture={(e) => {
        // The long press opened the card: it is not also a press on the trigger.
        if (!press.current.opened) return;
        press.current.opened = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => {
        if (press.current.opened) e.preventDefault();
        dom.onContextMenu?.(e);
      }}
      onFocus={(e: FocusEvent<HTMLElement>) => {
        dom.onFocus?.(e);
        if (e.target.matches(":focus-visible")) later(true, openDelay);
      }}
      onBlur={(e: FocusEvent<HTMLElement>) => {
        dom.onBlur?.(e);
        const next = e.relatedTarget as Node | null;
        if (!e.currentTarget.contains(next) && !card.current?.contains(next)) later(false, 0);
      }}
    >
      {slots.trigger ?? null}
      {children}
      {open && content
        ? createPortal(
          <div
            ref={card}
            id={id}
            role="tooltip"
            className="w-hovercard__card"
            data-placed={pos ? "" : undefined}
            style={pos ? { left: pos.left, top: pos.top } : undefined}
            onPointerEnter={(e) => e.pointerType !== "touch" && hold()}
            onPointerLeave={(e) => hover(e, false)}
          >
            {content}
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}
