/**
 * The DOM side of one element node: classes and inline style (`style.ts`), accessibility attributes from `attrs`,
 * and listeners that turn device input into handler invocations (`on`, gpui-kit names in `tree.ts` `HANDLER_KEYS`):
 *
 * - `click` (pointer or keyboard activation), `mousedown`/`mouseup` per button (a touch long press is the right
 *   button), `mousedownout` (a press anywhere else, capture phase), `mousemove` and `wheel` (at most one per 50 ms),
 *   `hover` (pointers that hover), `keydown`/`keyup`/`modifiers` on the focus path, `size` (layout size, sent when it
 *   changes). A DOM event reaches the innermost listening element only (`claim`).
 * - Widget events (`change`, `item`, `link`, …) belong to the widgets; `action` runs on the Mac (the host resolves
 *   key bindings), `drop` cannot come from a device.
 *
 * Nothing is sent while the env has no sink (stale data); key events only from an `act` device. Keys an input method
 * takes and keys the operating system keeps (`imeKey`, `systemKey`: Caps Lock, Globe, Ctrl+Space on an iPad) are
 * neither sent nor cancelled, so the OS still switches its input language with them.
 */

import {
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import type { ElementNode, JsonObject, JsonValue } from "@herdr-relay/protocol";
import { RenderContext } from "./context.ts";
import {
  type Button,
  buttonOf,
  claim,
  imeKey,
  keyPayload,
  modifierPayload,
  modifiersOf,
  placed,
  pressCount,
  releaseCount,
  systemKey,
} from "./events.ts";
import { animCss, nodeCss, stateClass } from "./style.ts";

const THROTTLE_MS = 50;
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
/** CSS px per wheel line (`WheelEvent.DOM_DELTA_LINE`). */
const LINE_PX = 16;

/** Keys whose browser default (scrolling the page) a key listener takes over. */
const SCROLL_KEYS: Record<string, true> = {
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  " ": true,
  PageUp: true,
  PageDown: true,
  Home: true,
  End: true,
};

/** gpui-kit `Role` (snake_case `gpui::Role`) → ARIA, where the names differ; others match once `_` is dropped. */
const ROLES: Record<string, string> = {
  default_button: "button",
  list_item: "listitem",
  tree_item: "treeitem",
  list_box_option: "option",
  menu_list_option: "option",
  menu_item: "menuitem",
  check_box: "checkbox",
  radio_button: "radio",
  text_input: "textbox",
  multiline_text_input: "textbox",
  search_input: "searchbox",
  number_input: "spinbutton",
  row_header: "rowheader",
  column_header: "columnheader",
  row_group: "rowgroup",
  layout_table: "presentation",
  layout_table_row: "presentation",
  layout_table_cell: "presentation",
  image: "img",
  pane: "region",
  progress_indicator: "progressbar",
  list_box: "listbox",
  combo_box: "combobox",
  editable_combo_box: "combobox",
  tab_list: "tablist",
  tab_panel: "tabpanel",
  menu_bar: "menubar",
  alert_dialog: "alertdialog",
  scroll_bar: "scrollbar",
  spin_button: "spinbutton",
};
const ARIA_ROLES: Record<string, true> = Object.fromEntries(
  ("alert application article banner blockquote button caption cell checkbox code columnheader combobox complementary " +
    "dialog document feed figure form grid gridcell group heading img link list listbox listitem log main marquee " +
    "math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation note option paragraph presentation " +
    "progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider " +
    "spinbutton status switch tab table tablist tabpanel term textbox timer toolbar tooltip tree treegrid treeitem")
    .split(" ").map((r) => [r, true]),
);
const SELECTABLE_ROLES: Record<string, true> = { tab: true, option: true, row: true, gridcell: true, treeitem: true };

function ariaRole(v: JsonValue | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const role = Object.hasOwn(ROLES, v) ? ROLES[v] : v.replaceAll("_", "");
  return Object.hasOwn(ARIA_ROLES, role) ? role : undefined;
}

const handlerId = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;

function buttons(v: unknown): Partial<Record<Button, number>> {
  if (typeof v !== "object" || v === null) return {};
  const o = v as Record<string, unknown>;
  return { left: handlerId(o.left), middle: handlerId(o.middle), right: handlerId(o.right) };
}

/** DOM props for one node's element (`ref` included). */
export type ElementDom =
  & HTMLAttributes<HTMLElement>
  & { ref: (el: HTMLElement | null) => void }
  & Record<
    `data-${string}`,
    string | undefined
  >;

export interface ElementBinding {
  dom: ElementDom;
  /** The element once mounted (for measuring). */
  el: RefObject<HTMLElement | null>;
}

/**
 * Props for the element drawing `node`: its classes (`kind` class first), inline style (`extra` merged last), ARIA and
 * listeners.
 */
export function useElement(node: ElementNode, kind: string, extra?: CSSProperties): ElementBinding {
  const env = useContext(RenderContext);
  const el = useRef<HTMLElement | null>(null);
  const ref = useCallback((e: HTMLElement | null) => {
    el.current = e;
  }, []);
  const on = (typeof node.on === "object" && node.on !== null ? node.on : {}) as Record<string, unknown>;
  const attrs: JsonObject = typeof node.attrs === "object" && node.attrs !== null ? node.attrs : {};
  const disabled = attrs.disabled === true;
  const send = env.send;
  const clickable = handlerId(on.click);
  const click = disabled ? undefined : clickable;
  const down = disabled ? {} : buttons(on.mousedown);
  const up = disabled ? {} : buttons(on.mouseup);
  const move = handlerId(on.mousemove);
  const hover = handlerId(on.hover);
  const wheel = handlerId(on.wheel);
  const keydown = handlerId(on.keydown);
  const keyup = handlerId(on.keyup);
  const mods = handlerId(on.modifiers);
  const size = handlerId(on.size);
  const outside = handlerId(on.mousedownout);
  const rightPress = down.right !== undefined || up.right !== undefined;
  const typing = send !== null && env.typing ? send : null;

  // Listeners that outlive one render (observers, document listeners, timers) read the committed ids here: ids
  // change with every render of the view.
  const live = useRef({ send, size, outside, move, wheel, rightDown: down.right, rightUp: up.right });
  useLayoutEffect(() => {
    live.current = { send, size, outside, move, wheel, rightDown: down.right, rightUp: up.right };
  });

  const pending = useRef<{ move?: ReturnType<typeof setTimeout>; wheel?: ReturnType<typeof setTimeout> }>({});
  const moveData = useRef<unknown>(null);
  const wheelData = useRef<{ x: number; y: number; lx: number; ly: number; lines: boolean; at: unknown } | null>(null);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; x: number; y: number; swallow: boolean }>({
    x: 0,
    y: 0,
    swallow: false,
  });

  // `on_size_change`: the layout size whenever it changes (and once at first layout).
  const hasSize = size !== undefined;
  useEffect(() => {
    const target = el.current;
    if (!hasSize || !target || typeof ResizeObserver === "undefined") return;
    let last = "";
    const ro = new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize?.[0];
      const width = Math.round((box ? box.inlineSize : entry.contentRect.width) * 100) / 100;
      const height = Math.round((box ? box.blockSize : entry.contentRect.height) * 100) / 100;
      const key = `${width}x${height}`;
      const { send, size } = live.current;
      if (key === last || !send || size === undefined) return;
      last = key;
      send(size, "size", { width, height });
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, [hasSize]);

  // `on_mouse_down_out`: a press outside this element, any button, in the capture phase.
  const hasOutside = outside !== undefined;
  useEffect(() => {
    const target = el.current;
    if (!hasOutside || !target) return;
    const listener = (e: PointerEvent) => {
      const button = buttonOf(e.button);
      const { send, outside } = live.current;
      if (!button || !send || outside === undefined || target.contains(e.target as Node)) return;
      const data = { button, click_count: pressCount(e, button), ...placed(e, target), modifiers: modifiersOf(e) };
      send(outside, "mousedown", data);
    };
    document.addEventListener("pointerdown", listener, true);
    return () => document.removeEventListener("pointerdown", listener, true);
  }, [hasOutside]);

  useEffect(() => () => {
    clearTimeout(pending.current.move);
    clearTimeout(pending.current.wheel);
    clearTimeout(press.current.timer);
  }, []);

  const cancelPress = () => {
    clearTimeout(press.current.timer);
    press.current.timer = undefined;
  };

  const dom: ElementDom = { ref };
  if (typeof node.id === "string") dom["data-id"] = node.id;

  if (click !== undefined) {
    dom.onClick = (e) => {
      if (press.current.swallow) {
        press.current.swallow = false;
        return;
      }
      if (claim(e.nativeEvent, "click")) {
        send?.(click, "click", { click_count: Math.max(1, e.detail), modifiers: modifiersOf(e) });
      }
    };
  }

  if (Object.values(down).some((h) => h !== undefined) || rightPress) {
    dom.onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
      const button = buttonOf(e.button);
      press.current.swallow = false;
      if (!button) return;
      if (rightPress && e.pointerType !== "mouse" && button === "left" && claim(e.nativeEvent, "longpress")) {
        // A touch has no right button: a long press is one.
        cancelPress();
        const target = e.currentTarget;
        const at = { clientX: e.clientX, clientY: e.clientY };
        const modifiers = modifiersOf(e);
        press.current = {
          x: e.clientX,
          y: e.clientY,
          swallow: false,
          timer: setTimeout(() => {
            press.current.timer = undefined;
            press.current.swallow = true;
            const { send, rightDown, rightUp } = live.current;
            const data = { button: "right", click_count: 1, ...placed(at, target), modifiers };
            if (rightDown !== undefined) send?.(rightDown, "mousedown", data);
            if (rightUp !== undefined) send?.(rightUp, "mouseup", data);
          }, LONG_PRESS_MS),
        };
      }
      const h = down[button];
      if (h === undefined || !claim(e.nativeEvent, `down:${button}`)) return;
      const data = {
        button,
        click_count: pressCount(e.nativeEvent, button),
        ...placed(e, e.currentTarget),
        modifiers: modifiersOf(e),
      };
      send?.(h, "mousedown", data);
    };
  }

  if (Object.values(up).some((h) => h !== undefined) || rightPress) {
    dom.onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
      cancelPress();
      const button = buttonOf(e.button);
      const h = button ? up[button] : undefined;
      if (!button || h === undefined || !claim(e.nativeEvent, `up:${button}`)) return;
      const data = {
        button,
        click_count: releaseCount(button),
        ...placed(e, e.currentTarget),
        modifiers: modifiersOf(e),
      };
      send?.(h, "mouseup", data);
    };
  }

  if (rightPress) {
    dom.onPointerCancel = cancelPress;
    dom.onContextMenu = (e) => e.preventDefault();
  }

  if (move !== undefined || rightPress) {
    dom.onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
      const p = press.current;
      if (p.timer !== undefined && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP) cancelPress();
      if (move === undefined || !send) return;
      moveData.current = { ...placed(e, e.currentTarget), modifiers: modifiersOf(e) };
      pending.current.move ??= setTimeout(() => {
        pending.current.move = undefined;
        const { send, move } = live.current;
        if (moveData.current !== null && move !== undefined) send?.(move, "mousemove", moveData.current);
        moveData.current = null;
      }, THROTTLE_MS);
    };
  }

  if (hover !== undefined) {
    const report = (hovered: boolean) => (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType !== "touch") send?.(hover, "hover", { hovered });
    };
    dom.onPointerEnter = report(true);
    dom.onPointerLeave = report(false);
  }

  if (wheel !== undefined) {
    dom.onWheel = (e) => {
      if (!send || !claim(e.nativeEvent, "wheel")) return;
      const scale = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? e.currentTarget.clientHeight : 1;
      const acc = wheelData.current ?? { x: 0, y: 0, lx: 0, ly: 0, lines: e.deltaMode === 1, at: null };
      // GPUI's delta is how far the content moves: scrolling down is negative.
      acc.x -= e.deltaX * scale;
      acc.y -= e.deltaY * scale;
      if (e.deltaMode === 1) {
        acc.lx -= e.deltaX;
        acc.ly -= e.deltaY;
      }
      acc.at = { ...placed(e, e.currentTarget), modifiers: modifiersOf(e) };
      wheelData.current = acc;
      pending.current.wheel ??= setTimeout(() => {
        pending.current.wheel = undefined;
        const w = wheelData.current;
        wheelData.current = null;
        const { send, wheel } = live.current;
        if (!w || !send || wheel === undefined) return;
        const lines = w.lines ? { delta_lines: { x: w.lx, y: w.ly } } : {};
        send(wheel, "wheel", { delta: { x: w.x, y: w.y }, touch_phase: "moved", ...(w.at as object), ...lines });
      }, THROTTLE_MS);
    };
  }

  // Keyboard activation of a click target (GPUI: "Keyboard activation counts as one"), unless it reads keys itself.
  const activates = click !== undefined && keydown === undefined;
  if (activates || keydown !== undefined || mods !== undefined) {
    dom.onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
      const activation = (e.key === "Enter" || e.key === " ") && !imeKey(e) && !systemKey(e);
      if (activates && e.target === e.currentTarget && activation) {
        // The press is this element's click; listeners further out do not also hear it as a key.
        e.preventDefault();
        claim(e.nativeEvent, "key");
        if (claim(e.nativeEvent, "click")) send?.(click, "click", { click_count: 1, modifiers: modifiersOf(e) });
        return;
      }
      if (mods !== undefined) {
        const p = modifierPayload(e);
        if (p && claim(e.nativeEvent, "modifiers")) typing?.(mods, "key", p);
      }
      if (keydown === undefined) return;
      const p = keyPayload(e, true);
      if (!p || !claim(e.nativeEvent, "key") || !typing) return;
      typing(keydown, "key", p);
      const t = e.target as HTMLElement;
      const editable = t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA";
      if (Object.hasOwn(SCROLL_KEYS, e.key) && !editable) e.preventDefault();
    };
  }
  if (keyup !== undefined || mods !== undefined) {
    dom.onKeyUp = (e: ReactKeyboardEvent<HTMLElement>) => {
      if (mods !== undefined) {
        const p = modifierPayload(e);
        if (p && claim(e.nativeEvent, "modifiers")) typing?.(mods, "key", p);
      }
      const p = keyup === undefined ? null : keyPayload(e, false);
      if (p && keyup !== undefined && claim(e.nativeEvent, "key")) typing?.(keyup, "key", p);
    };
  }

  // Accessibility (gpui-kit attrs: announced, never drawn).
  const tracksFocus = attrs.track_focus !== undefined;
  const role = ariaRole(attrs.role) ?? (clickable !== undefined ? "button" : undefined);
  if (role) dom.role = role;
  if (typeof attrs.tab_index === "number" && Number.isInteger(attrs.tab_index)) dom.tabIndex = attrs.tab_index;
  else if (click !== undefined) dom.tabIndex = attrs.tab_stop === false ? -1 : 0;
  else if (tracksFocus) dom.tabIndex = attrs.tab_stop === true ? 0 : -1;
  if (tracksFocus) {
    dom["data-track-focus"] = "";
    if (env.overlay) dom["data-autofocus"] = "";
  }
  if (typeof attrs.tooltip === "string" && attrs.tooltip) dom.title = attrs.tooltip;
  if (typeof attrs.accessibility_label === "string" && attrs.accessibility_label) {
    dom["aria-label"] = attrs.accessibility_label;
  }
  if (disabled) dom["aria-disabled"] = true;
  if (typeof attrs.aria_selected === "boolean") dom["aria-selected"] = attrs.aria_selected;
  if (typeof attrs.selected === "boolean") {
    if (role && Object.hasOwn(SELECTABLE_ROLES, role)) dom["aria-selected"] = attrs.selected;
    else if (role === "button") dom["aria-pressed"] = attrs.selected;
  }
  if (typeof attrs.pressed === "boolean") dom["aria-pressed"] = attrs.pressed;
  if (typeof attrs.checked === "boolean") dom["aria-checked"] = attrs.checked;
  if (typeof attrs.aria_level === "number") dom["aria-level"] = attrs.aria_level;
  if (Array.isArray(attrs.set_position) && attrs.set_position.length === 2) {
    const [pos, setSize] = attrs.set_position;
    if (typeof pos === "number" && typeof setSize === "number") {
      dom["aria-posinset"] = pos;
      dom["aria-setsize"] = setSize;
    }
  }
  if (typeof attrs.value === "number" && attrs.indeterminate !== true) dom["aria-valuenow"] = attrs.value;

  const css = nodeCss(node.style);
  const anim = animCss(node.anim);
  dom.className = [
    kind,
    css.className,
    anim.className,
    stateClass(node.states),
    rightPress ? "r-press" : "",
    tracksFocus || click !== undefined ? "r-focusable" : "",
  ].filter(Boolean).join(" ");
  dom.style = { ...css.style, ...anim.style, ...extra };
  return { dom, el };
}
