// `gpui-base`: Base components as recording factories, retained states as small in-memory objects. Every runtime
// export of `declare module "gpui-base"` in gpui-kit.d.ts exists, so any mod's named imports link; the ones the host
// does not model throw and are reported as unknown when called.

import {
  addHandler,
  currentStore,
  element,
  emitFor,
  hostObjects,
  lateHostObjects,
  lazyList,
  LIST_WINDOW,
  listCx,
  markDirty,
  noteUnknown,
  renderingCopy,
  report,
  ser,
  setProp,
  unsupported,
} from "../runtime.js";

export const h_flex = () => element("h_flex");
export const v_flex = () => element("v_flex");
export const h_resizable = (id) => element("h_resizable").id(id);
export const v_resizable = (id) => element("v_resizable").id(id);
export const resizable_panel = () => element("resizable_panel");
export const dock_content = () => element("dock_content");

/**
 * A Base component: `new(id)` (the id becomes the element id), `new()` for the parts that take none; further
 * arguments (`TableRow.new(id, row_index)` …) are kept as `props.args`.
 */
const component = (name) => ({
  new: (...args) => {
    const el = element(name);
    const [id, ...rest] = args;
    if (typeof id === "string" || typeof id === "number") el.id(String(id));
    else if (id !== undefined) rest.unshift(id);
    if (rest.length > 0) setProp(el, "args", rest.map((a) => ser(a)));
    return el;
  },
});
/** A component built over a retained state (`Input.new(state)` …): the state's id and options go into `props`. */
const stateComponent = (name) => ({
  new: (state) => {
    const r = retainedStates.get(state);
    if (!r) {
      noteUnknown("gpui-base", `${name}.new(non-state)`);
      return element(name, { state: ser(state) });
    }
    const el = element(name, { state: r.id, ...r.props() });
    if (r.input) addHandler(el, "on_change", r.input);
    return el;
  },
});

export const Button = component("Button");
export const Link = component("Link");
export const Checkbox = component("Checkbox");
export const Switch = component("Switch");
export const Tabs = component("Tabs");
export const Tab = component("Tab");
export const Progress = component("Progress");
export const ProgressTrack = component("ProgressTrack");
export const ProgressIndicator = component("ProgressIndicator");
export const Avatar = component("Avatar");
export const AvatarImage = { new: (path) => element("AvatarImage", { src: String(path) }) };
export const AvatarFallback = component("AvatarFallback");
export const Pagination = component("Pagination");
export const Accordion = component("Accordion");
export const AccordionItem = component("AccordionItem");
export const AccordionHeader = { new: (trigger) => element("AccordionHeader").trigger(trigger) };
export const AccordionPanel = component("AccordionPanel");
export const AccordionTrigger = component("AccordionTrigger");
export const Radio = component("Radio");
export const Toggle = component("Toggle");
export const RadioGroup = component("RadioGroup");
export const ToggleGroup = component("ToggleGroup");
export const Table = component("Table");
export const TableHeader = component("TableHeader");
export const TableBody = component("TableBody");
export const TableRow = component("TableRow");
export const TableHead = component("TableHead");
export const TableCell = component("TableCell");
export const TableCaption = component("TableCaption");
export const Collapsible = component("Collapsible");
export const Popover = component("Popover");
export const HoverCard = component("HoverCard");
export const Popup = { new: (id, trigger) => element("Popup").id(String(id)).trigger(trigger) };
export const Select = component("Select");
export const Combobox = component("Combobox");
export const DatePicker = component("DatePicker");
export const Input = stateComponent("Input");
export const NumberInput = stateComponent("NumberInput");
export const Textarea = stateComponent("Textarea");
export const Editor = stateComponent("Editor");
export const Slider = stateComponent("Slider");
export const SliderTrack = stateComponent("SliderTrack");
export const SliderIndicator = stateComponent("SliderIndicator");
export const SliderThumb = stateComponent("SliderThumb");
export const OtpInput = stateComponent("OtpInput");

export const TextView = {
  html: (id, html) => element("TextView", { format: "html", source: String(html) }).id(String(id)),
  markdown: (id, markdown) => element("TextView", { format: "markdown", source: String(markdown) }).id(String(id)),
};

export const Scrollbar = {
  new: (id) => element("Scrollbar", { axis: "both", target: String(id) }),
  horizontal: (id) => element("Scrollbar", { axis: "horizontal", target: String(id) }),
  vertical: (id) => element("Scrollbar", { axis: "vertical", target: String(id) }),
};

/** `item_sizes` is one number for every row or one per row; an array is kept for the recorded rows only. */
function virtualList(tag, id, count, sizes, getKey, render) {
  const n = Math.min(Math.max(0, Math.trunc(Number(count) || 0)), LIST_WINDOW);
  const extra = { sizes: Array.isArray(sizes) ? sizes.slice(0, n).map((s) => ser(s)) : ser(sizes) };
  return lazyList(tag, id, count, extra, getKey, (el, rows) => el.children(render({ start: 0, end: rows }, listCx())));
}
export const v_virtual_list = (...a) => virtualList("v_virtual_list", ...a);
export const h_virtual_list = (...a) => virtualList("h_virtual_list", ...a);

// ---------------------------------------------------------------------------------------------------------------------
// Retained states. Each has an id `<Kind>:<n>` (what a widget's `props.state` and `emit focus` name), a `props()`
// snapshot for the element built over it, and — for text states — an input handler the host registers as the
// element's `on_change`: a device sends it the protocol `InputData` (`{value, event?, secondary?, shift?}`, or the
// bare value), the state takes the value and runs the mod's `on(event)` handler.

/** Retained state object → `{id, props(), input?}`. */
const retainedStates = new WeakMap();
let stateSeq = 0;

/** A retained state: `known` methods behave, the rest are counted as unknown and return undefined. */
function retained(kind, known, props, input) {
  const id = `${kind}:${++stateSeq}`;
  const base = { release: () => true, ...known };
  const obj = new Proxy(base, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
      noteUnknown(kind, prop);
      return () => undefined;
    },
  });
  retainedStates.set(obj, { id, props, input });
  hostObjects.set(obj, id);
  return { id, obj };
}

const TEXT_EVENTS = ["change", "submit", "focus", "blur", "paste_other"];

/**
 * `InputState`, `TextareaState`, `EditorState`. `extra(set)` adds the kind's own setters; `set(key, value)` records
 * one widget option into the element props.
 */
function textState(kind, options, extra) {
  const o = options ?? {};
  let value = String(o.value ?? "");
  const opts = {};
  for (const [k, v] of Object.entries(o)) if (k !== "value" && v !== undefined) opts[k] = ser(v);
  const handlers = new Map();
  const owner = currentStore()?.copy ?? null;
  const set = (key, v) => {
    opts[key] = ser(v);
    if (owner) markDirty(owner);
  };
  const textOf = (next) => (typeof next === "string" ? next : String(next?.text ?? ""));
  /** A value set by the mod reaches the device through a re-render of the copy that owns the state. */
  const setValue = (next) => {
    if (next === value) return;
    value = next;
    if (owner) markDirty(owner);
  };
  let id = "";
  const known = {
    value: () => value,
    set_value: (next) => setValue(textOf(next)),
    on(event, handler) {
      if (!TEXT_EVENTS.includes(event) || typeof handler !== "function") noteUnknown(kind, `on(${String(event)})`);
      handlers.set(String(event), handler);
      return true;
    },
    ...extra(set),
  };
  if (kind !== "EditorState") {
    Object.assign(known, {
      replace: (text) => setValue(String(text)),
      content: () => ({ text: value, tokens: [] }),
      tokens: () => [],
      focus: () => {
        const copy = currentStore()?.copy ?? owner;
        if (copy) emitFor(copy, "focus", [id]);
      },
    });
  }
  /** A device's input: take the value, then run the mod's handler for the event (a changed value fires `change`). */
  const input = (data, ...rest) => {
    const cx = rest.at(-1);
    const d = data !== null && typeof data === "object" ? data : { value: data };
    const event = typeof d.event === "string" ? d.event : "change";
    const payload = {};
    if (typeof d.secondary === "boolean") payload.secondary = d.secondary;
    if (typeof d.shift === "boolean") payload.shift = d.shift;
    const changed = typeof d.value === "string" && d.value !== value;
    if (changed) value = d.value;
    const run = (name) => {
      const h = handlers.get(name);
      if (!h) return;
      try {
        const r = h(payload, cx);
        if (r && typeof r.then === "function") r.then(undefined, (e) => report(owner, `${kind}.on(${name})`, e));
      } catch (e) {
        report(owner, `${kind}.on(${name})`, e);
      }
    };
    if (changed && event !== "change") run("change");
    if (event !== "change" || changed) run(event);
  };
  const r = retained(kind, known, () => ({ ...opts, value }), input);
  id = r.id;
  return r.obj;
}

export const InputState = {
  new: (options) =>
    textState("InputState", options, (set) => ({
      set_step: (v) => set("step", v),
      set_min: (v) => set("min", v),
      set_max: (v) => set("max", v),
      set_masked: (v) => set("masked", Boolean(v)),
      set_loading: (v) => set("loading", Boolean(v)),
    })),
};
export const TextareaState = {
  new: (options) =>
    textState("TextareaState", options, (set) => ({
      set_rows: (rows) => set("rows", Number(rows)),
      set_auto_grow: (min_rows, max_rows) =>
        set("auto_grow", { min_rows: Number(min_rows), max_rows: Number(max_rows) }),
      set_soft_wrap: (wrap) => set("soft_wrap", Boolean(wrap)),
    })),
};
export const EditorState = { new: (options) => textState("EditorState", options, () => ({})) };

/** Scroll requests of this host, of both handle kinds, numbered from 1: a device carries out each once. */
let scrollSeq = 0;

/**
 * A retained scroll handle. A request (`ask(method, request)`: `{index, strategy?}`, `{bottom: true}`, or `null` for an
 * index that names no item — negative, not a number — which drops the pending one) replaces the earlier one, as GPUI's
 * deferred request does, takes the next `seq` and re-renders the copy that owns the handle, unless that copy is
 * rendering now (the tree it is building carries the request). `track_scroll(handle)` records the handle id, or
 * `{handle, scroll_to: {seq, …request}}` while a request is kept, read when the tree is serialised
 * (`lateHostObjects`), so a request made later in the same render reaches it. Every tree keeps the latest request; a
 * device carries it out once per `seq`, after layout (PROTOCOL.md "Scroll requests"). `release()` returns true; after
 * it every use throws, `release()` included.
 */
function scrollHandle(kind, methods) {
  const owner = currentStore()?.copy ?? null;
  let request = null;
  let released = false;
  const use = (what) => {
    if (released) throw new TypeError(`${what}: the ${kind} was released`);
  };
  const ask = (method, next) => {
    use(`${kind}.${method}()`);
    request = next === null ? null : { seq: ++scrollSeq, ...next };
    const copy = owner ?? currentStore()?.copy;
    if (copy && copy !== renderingCopy()) markDirty(copy);
  };
  const { id, obj } = retained(kind, {
    ...methods(ask),
    release() {
      use(`${kind}.release()`);
      released = true;
      return true;
    },
  }, () => ({}));
  lateHostObjects.set(obj, () => {
    use("track_scroll()");
    return request === null ? id : { handle: id, scroll_to: { ...request } };
  });
  return obj;
}

/** An item index as GPUI takes it (a whole number from 0), or `null`. */
function itemIndex(index) {
  const i = Math.trunc(Number(index));
  return Number.isSafeInteger(i) && i >= 0 ? i : null;
}

/**
 * A plain scroll area's position: `scroll_to_item(index)` reveals direct child `index` with the smallest scroll
 * (`{index}`).
 */
export const ScrollHandle = {
  new: () =>
    scrollHandle("ScrollHandle", (ask) => ({
      scroll_to_item(index) {
        const i = itemIndex(index);
        ask("scroll_to_item", i === null ? null : { index: i });
      },
    })),
};

/**
 * A virtual list's position: `scroll_to_item(index, strategy?)` puts item `index` on screen, `"top"` (the default,
 * `{index}`) at the near edge with the smallest scroll, `"center"` (`{index, strategy: "center"}`) in the middle;
 * `scroll_to_bottom()` (`{bottom: true}`) scrolls to the end. Another strategy is reported as unknown and taken as
 * `"top"`.
 */
export const VirtualListScrollHandle = {
  new: () =>
    scrollHandle("VirtualListScrollHandle", (ask) => ({
      scroll_to_item(index, strategy) {
        if (strategy !== undefined && strategy !== "top" && strategy !== "center") {
          noteUnknown("VirtualListScrollHandle", `scroll_to_item(strategy ${JSON.stringify(strategy)})`);
        }
        const i = itemIndex(index);
        ask("scroll_to_item", i === null ? null : strategy === "center" ? { index: i, strategy } : { index: i });
      },
      scroll_to_bottom() {
        ask("scroll_to_bottom", { bottom: true });
      },
    })),
};

const notModeled = (name) => ({
  new: () => {
    throw unsupported("gpui-base", name);
  },
});
export const CalendarState = notModeled("CalendarState");
export const SliderState = notModeled("SliderState");
export const OtpState = notModeled("OtpState");
export const DockArea = notModeled("DockArea");
export function dock_area() {
  throw unsupported("gpui-base", "dock_area");
}
export function pagination_items() {
  throw unsupported("gpui-base", "pagination_items");
}
export function set_theme() {
  throw unsupported("gpui-base", "set_theme");
}
