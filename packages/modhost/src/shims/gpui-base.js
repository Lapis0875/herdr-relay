// `gpui-base`: Base components as recording factories, retained states as small in-memory objects. Every runtime
// export of `declare module "gpui-base"` in gpui-kit.d.ts exists, so any mod's named imports link; the ones the host
// does not model throw and are reported as unknown when called.

import {
  addHandler,
  currentStore,
  element,
  emitFor,
  hostObjects,
  lazyList,
  LIST_WINDOW,
  listCx,
  markDirty,
  noteUnknown,
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

export const VirtualListScrollHandle = {
  new: () => retained("VirtualListScrollHandle", { scroll_to_item() {}, scroll_to_bottom() {} }, () => ({})).obj,
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
