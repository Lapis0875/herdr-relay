/**
 * Element trees.
 *
 * - `RecordedTree` — what a mod host records for one render of one copy (control `tree` message): the element calls in
 *   order, as the gpui-kit/gpui-base shims saw them (DESIGN-v2 §1.5, spike shape kept).
 * - `ElementTree` — what a device renders (`view.tree`, `patch` ops): CSS styles, refinement states, native motion,
 *   handler ids, widgets (DESIGN.md §5.2 node + `k:"error"`).
 * - `toElementTree()` — the conversion, using the GPUI style parser (`gpui-style.ts`).
 */

import {
  BEHAVIOURAL_METHODS,
  mergeStyle,
  parseStyleCall,
  parseStyleName,
  type Style,
  styleMethodKind,
  StyleSchema,
} from "./gpui-style.ts";
import {
  array,
  define,
  enumOf,
  integer,
  is,
  type JsonObject,
  jsonObjectRef,
  jsonPointer,
  type JsonValue,
  jsonValueRef,
  literal,
  nullable,
  number,
  object,
  record,
  type Same,
  type Schema,
  type Static,
  string,
  tagged,
  tuple,
  tupleRest,
  union,
} from "./schema.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Shared value shapes.

export const COLOR_PATTERN = "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$";
/** A concrete `#rgb`, `#rrggbb` or `#rrggbbaa` colour (gpui-kit `Color`). */
export const ColorSchema = define("Color", () => string({ pattern: COLOR_PATTERN }));

/** The properties GPUI animates natively (gpui-shell `MotionProperty`). */
export const MOTION_PROPERTIES = ["opacity", "width", "height", "left", "top"] as const;
export const MotionPropertySchema = define("MotionProperty", () => enumOf(MOTION_PROPERTIES));
export type MotionProperty = Static<typeof MotionPropertySchema>;

export const MotionEasingSchema = define(
  "MotionEasing",
  () => enumOf(["linear", "ease-in", "ease-out", "ease-in-out"]),
);
export type MotionEasing = Static<typeof MotionEasingSchema>;

export const TransitionPolicySchema = define("TransitionPolicy", () =>
  object(
    { duration: number({ minimum: 0, description: "ms" }) },
    { delay: number({ minimum: 0, description: "ms" }), easing: MotionEasingSchema },
  ));
export type TransitionPolicy = Static<typeof TransitionPolicySchema>;

export const SpringPolicySchema = define("SpringPolicy", () =>
  object({}, {
    response: number({ exclusiveMinimum: 0, description: "approximate response period, ms" }),
    damping: number({ minimum: 0 }),
    epsilon: number({ exclusiveMinimum: 0 }),
  }));
export type SpringPolicy = Static<typeof SpringPolicySchema>;

/** `loop(prop, {from, to, period?, easing?})` with the default period (1000 ms) filled in. */
export const LoopAnimationSchema = define("LoopAnimation", () =>
  object(
    { prop: MotionPropertySchema, from: number(), to: number(), period: number({ minimum: 100, description: "ms" }) },
    { easing: MotionEasingSchema },
  ));
export type LoopAnimation = Static<typeof LoopAnimationSchema>;

/** Native motion: the renderer maps it to CSS animations/transitions. */
export const AnimSchema = define("Anim", () =>
  object({}, {
    spin: number({ minimum: 100, description: "ms per turn" }),
    loop: LoopAnimationSchema,
    transition: array(tuple([MotionPropertySchema, TransitionPolicySchema])),
    frames: tuple([array(string()), number({ minimum: 16, description: "ms per frame" })]),
    spring: array(tuple([MotionPropertySchema, SpringPolicySchema])),
  }));
export type Anim = Static<typeof AnimSchema>;

/** The style refinements of gpui-kit (`hover(el => …)` …). */
export const REFINEMENTS = [
  "hover",
  "active",
  "focus",
  "range_style",
  "cell_style",
  "cell_active_style",
  "caret_style",
] as const;
export type Refinement = (typeof REFINEMENTS)[number];

export const StatesSchema = define("States", () =>
  object({}, {
    hover: StyleSchema,
    active: StyleSchema,
    focus: StyleSchema,
    range_style: StyleSchema,
    cell_style: StyleSchema,
    cell_active_style: StyleSchema,
    caret_style: StyleSchema,
  }));
export type States = Static<typeof StatesSchema>;

const handlerId = () => integer({ minimum: 0 });

export const ButtonHandlersSchema = define(
  "ButtonHandlers",
  () => object({}, { left: handlerId(), right: handlerId(), middle: handlerId() }),
);

/**
 * Handler ids by event (`HANDLER_KEYS` maps the gpui-kit method to its key). Ids are per view and invalidated on
 * each render of that view; a device sends them back in `event.handler`. `link` is TextView's `on_link_click`: the
 * device reports an activated link as `event {kind:"link", data:{href}}`, which reaches the handler as `[href]`.
 */
export const HandlersSchema = define("Handlers", () =>
  object({}, {
    click: handlerId(),
    mousedown: ButtonHandlersSchema,
    mouseup: ButtonHandlersSchema,
    mousemove: handlerId(),
    mousedownout: handlerId(),
    hover: handlerId(),
    wheel: handlerId(),
    keydown: handlerId(),
    keyup: handlerId(),
    modifiers: handlerId(),
    size: handlerId(),
    item: handlerId(),
    itemsecondary: handlerId(),
    change: handlerId(),
    step: handlerId(),
    openchange: handlerId(),
    confirm: handlerId(),
    dismiss: handlerId(),
    resize: handlerId(),
    drop: handlerId(),
    action: record(handlerId()),
    tokenclick: handlerId(),
    tokenhover: handlerId(),
    link: handlerId(),
  }));
export type Handlers = Static<typeof HandlersSchema>;

/** gpui-kit handler method → `Handlers` key. */
export const HANDLER_KEYS: Readonly<Record<string, keyof Handlers>> = {
  on_click: "click",
  on_mouse_down: "mousedown",
  on_mouse_up: "mouseup",
  on_mouse_move: "mousemove",
  on_mouse_down_out: "mousedownout",
  on_hover: "hover",
  on_scroll_wheel: "wheel",
  on_key_down: "keydown",
  on_key_up: "keyup",
  on_modifiers_changed: "modifiers",
  on_size_change: "size",
  on_item_click: "item",
  on_item_secondary_click: "itemsecondary",
  on_change: "change",
  on_step: "step",
  on_open_change: "openchange",
  on_confirm: "confirm",
  on_dismiss: "dismiss",
  on_resize: "resize",
  on_drop: "drop",
  on_action: "action",
  on_token_click: "tokenclick",
  on_token_hover: "tokenhover",
  on_link_click: "link",
};

export const WIDGET_TYPES = [
  "input",
  "textarea",
  "editor",
  "markdown",
  "html",
  "vlist",
  "hovercard",
  "resizable",
  "scrollbar",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** A client-side widget: `state` names the retained host state (or the element id); `props` are its recorded props. */
export const WidgetSchema = define(
  "Widget",
  () => object({ type: enumOf(WIDGET_TYPES), state: string(), props: jsonObjectRef }),
);
export type Widget = Static<typeof WidgetSchema>;

/** `PathBuilder` operations, as recorded: `[op, ...args]` (coordinates are px numbers or `"<n>%"` strings). */
export const PATH_OPS = [
  "move_to",
  "line_to",
  "curve_to",
  "cubic_bezier_to",
  "arc_to",
  "add_polygon",
  "close",
  "dash_array",
] as const;
export const PathSpecSchema = define("PathSpec", () =>
  object(
    { kind: enumOf(["fill", "stroke"]), ops: array(tupleRest([enumOf(PATH_OPS)], jsonValueRef)) },
    { width: number({ minimum: 0, description: "stroke width, px" }) },
  ));
export type PathSpec = Static<typeof PathSpecSchema>;

export const BackgroundStopSchema = define(
  "BackgroundStop",
  () => object({ color: ColorSchema, percentage: number() }),
);

/** gpui-kit `Background` (used by `window.paint_path`). */
export const BackgroundSchema = define("Background", () => {
  const common = { opacity: number({ minimum: 0, maximum: 1 }), color_space: enumOf(["srgb", "oklab"]) };
  const end = union([ColorSchema, BackgroundStopSchema]);
  return tagged("kind", [
    object({ kind: literal("solid"), color: ColorSchema }, common),
    object({ kind: literal("linear_gradient"), angle: number(), from: end, to: end }, common),
    object({ kind: literal("pattern_slash"), color: ColorSchema, width: number(), interval: number() }, common),
    object({ kind: literal("checkerboard"), color: ColorSchema, size: number() }, common),
  ]);
});
export type Background = Static<typeof BackgroundSchema>;

/** What a path is painted with: a colour or a `Background`. */
export const PaintSchema = define("Paint", () => union([ColorSchema, BackgroundSchema]));
export type Paint = Static<typeof PaintSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// ElementTree (client).

interface ElementNodeBase {
  /** CSS for the element (`gpui-style.ts`). */
  style: Style;
  id?: string;
  /** The gpui-kit/gpui-base factory (`div`, `h_flex`, `Button`, …); set on `k:"el"`. */
  tag?: string;
  states?: States;
  anim?: Anim;
  on?: Handlers;
  widget?: Widget;
  /** Non-style behavioural settings by gpui-kit method name (`tooltip`, `disabled`, `role`, `scrollbar`, …). */
  attrs?: JsonObject;
  /** Named slot elements (`trigger`, `content`, …). */
  slots?: Record<string, ElementNode>;
  children?: ElementNode[];
}
export interface ElNode extends ElementNodeBase {
  k: "el";
}
export interface TextNode extends ElementNodeBase {
  k: "text";
  text: string;
}
export interface SvgNode extends ElementNodeBase {
  k: "svg";
  /** Path relative to the app home (`mods/<folder>/x.svg`, `icons/…`), served by the bridge's static route. */
  src: string;
}
export interface ImageNode extends ElementNodeBase {
  k: "image";
  src: string;
}
export interface PathNode extends ElementNodeBase {
  k: "path";
  path: PathSpec;
  paint: Paint;
}
export interface TerminalNode extends ElementNodeBase {
  k: "terminal";
  terminal: string;
}
/** A retained nested view (`cx.new(...)` entity) rendered by its own `view.tree`. */
export interface ViewNode extends ElementNodeBase {
  k: "view";
  view: string;
}
/** A block that cannot render (host failed, folder refused, unconvertible element). */
export interface ErrorNode extends ElementNodeBase {
  k: "error";
  reason: string;
  folder?: string;
}

/** One node of an `ElementTree`, discriminated on `k`. */
export type ElementNode = ElNode | TextNode | SvgNode | ImageNode | PathNode | TerminalNode | ViewNode | ErrorNode;
export type ElementTree = ElementNode;
export type ElementKind = ElementNode["k"];

export const ElementNodeSchema: Schema<ElementNode> = define("ElementNode", () => elementNodeBody);

const nodeOptional = {
  id: string(),
  tag: string(),
  states: StatesSchema,
  anim: AnimSchema,
  on: HandlersSchema,
  widget: WidgetSchema,
  attrs: jsonObjectRef,
  slots: record(ElementNodeSchema),
  children: array(ElementNodeSchema),
};
const style = StyleSchema;

const elementNodeBody = tagged("k", [
  object({ k: literal("el"), style }, nodeOptional),
  object({ k: literal("text"), style, text: string() }, nodeOptional),
  object({ k: literal("svg"), style, src: string({ minLength: 1 }) }, nodeOptional),
  object({ k: literal("image"), style, src: string({ minLength: 1 }) }, nodeOptional),
  object({ k: literal("path"), style, path: PathSpecSchema, paint: PaintSchema }, nodeOptional),
  object({ k: literal("terminal"), style, terminal: string({ minLength: 1 }) }, nodeOptional),
  object({ k: literal("view"), style, view: string({ minLength: 1 }) }, nodeOptional),
  object({ k: literal("error"), style, reason: string() }, { ...nodeOptional, folder: string() }),
]);

const _elementNodeMatches: Same<Static<typeof elementNodeBody>, ElementNode> = true;

export const ElementTreeSchema = ElementNodeSchema;

/** The node a block shows when it cannot render (DESIGN-v2 §1.6: `{k:"error", folder, reason}`). */
export function errorNode(reason: string, folder?: string): ErrorNode {
  return folder === undefined ? { k: "error", style: {}, reason } : { k: "error", style: {}, reason, folder };
}

// ---------------------------------------------------------------------------------------------------------------------
// RecordedTree (mod host).

/** One recorded builder call: `[method, ...args]`. */
export type RecordedCall = [string, ...JsonValue[]];
export const RecordedCallSchema = define(
  "RecordedCall",
  () => tupleRest([string({ minLength: 1 })], jsonValueRef),
);

/** A function-valued builder call (`on_click(fn)`, `on_mouse_down("right", fn)`): its handler id and other args. */
export const RecordedHandlerSchema = define(
  "RecordedHandler",
  () => object({ event: string({ minLength: 1 }), id: handlerId() }, { args: array(jsonValueRef) }),
);
export type RecordedHandler = Static<typeof RecordedHandlerSchema>;

/** Refinement calls (`hover(el => el.bg(…))`) by refinement name. */
export const RecordedStatesSchema = define("RecordedStates", () => {
  const calls = array(RecordedCallSchema);
  return object({}, {
    hover: calls,
    active: calls,
    focus: calls,
    range_style: calls,
    cell_style: calls,
    cell_active_style: calls,
    caret_style: calls,
  });
});
export type RecordedStates = Static<typeof RecordedStatesSchema>;

/**
 * One recorded element. `tag` is the factory (`div`, `h_flex`, `svg`, `image`, `paint_path`, `Input`, `TextView`,
 * `v_virtual_list`, `Scrollbar`, `HoverCard`, …); `props` carry factory data the converter reads: `src`
 * (`svg`/`image`), `path` + `paint` (`paint_path`), `terminal`, `format` + `source` (`TextView`), `state` (retained
 * state id of `Input`/`Textarea`/`Editor`), plus any other recorded factory arguments (kept as widget props).
 */
export interface RecordedElement {
  tag: string;
  id?: string | null;
  style: RecordedCall[];
  handlers: RecordedHandler[];
  children: RecordedNode[];
  states?: RecordedStates;
  slots?: Record<string, RecordedElement>;
  props?: JsonObject;
}
/** A string child, or a render that returned a string. */
export interface RecordedText {
  text: string;
}
/** A retained nested view (`cx.new(...)` entity) mounted as a child or returned from render. */
export interface RecordedEntity {
  entity: string;
}
export type RecordedNode = RecordedElement | RecordedText | RecordedEntity;
/** The whole tree of one render. */
export type RecordedTree = RecordedNode;

export const RecordedElementSchema: Schema<RecordedElement> = define("RecordedElement", () => recordedElementBody);
export const RecordedNodeSchema: Schema<RecordedNode> = define("RecordedNode", () => recordedNodeBody);
export const RecordedTreeSchema = RecordedNodeSchema;

const recordedElementBody = object({
  tag: string({ minLength: 1 }),
  style: array(RecordedCallSchema),
  handlers: array(RecordedHandlerSchema),
  children: array(RecordedNodeSchema),
}, {
  id: nullable(string()),
  states: RecordedStatesSchema,
  slots: record(RecordedElementSchema),
  props: jsonObjectRef,
});
const recordedNodeBody = union([
  RecordedElementSchema,
  object({ text: string() }),
  object({ entity: string({ minLength: 1 }) }),
]);

const _recordedElementMatches: Same<Static<typeof recordedElementBody>, RecordedElement> = true;
const _recordedNodeMatches: Same<Static<typeof recordedNodeBody>, RecordedNode> = true;

// ---------------------------------------------------------------------------------------------------------------------
// Conversion.

/** Something the converter dropped: `path` is the JSON Pointer into the recorded tree. */
export interface TreeDiagnostic {
  path: string;
  method: string;
  message: string;
}

export interface ConvertedTree {
  tree: ElementNode;
  diagnostics: TreeDiagnostic[];
}

const WIDGET_TAGS: Record<string, WidgetType> = {
  Input: "input",
  Textarea: "textarea",
  Editor: "editor",
  v_virtual_list: "vlist",
  h_virtual_list: "vlist",
  list: "vlist",
  uniform_list: "vlist",
  HoverCard: "hovercard",
  h_resizable: "resizable",
  v_resizable: "resizable",
  Scrollbar: "scrollbar",
};

const BORDER_WIDTHS = ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"];
const BUTTONS = ["left", "right", "middle"] as const;

/** GPUI draws a border from width + colour; CSS also needs a style. */
function withBorderStyle(s: Style): Style {
  if (s.borderStyle === undefined && BORDER_WIDTHS.some((k) => k in s)) s.borderStyle = "solid";
  return s;
}

class Converter {
  readonly diagnostics: TreeDiagnostic[] = [];

  private note(path: string, method: string, message: string): void {
    this.diagnostics.push({ path, method, message });
  }

  node(rec: RecordedNode, path: string): ElementNode {
    if ("tag" in rec) return this.element(rec, path);
    if ("text" in rec) return { k: "text", style: {}, text: rec.text };
    return { k: "view", style: {}, view: rec.entity };
  }

  /** Style-only calls (base `style` of a refinement): generated and argument style methods. */
  private styleCall(target: Style, name: string, args: JsonValue[], path: string): boolean {
    const kind = styleMethodKind(name);
    if (kind !== "generated" && kind !== "arg") return false;
    const r = parseStyleCall(name, args);
    if (r.ok) mergeStyle(target, r.style);
    else this.note(path, name, r.error);
    return true;
  }

  private anim(anim: Anim, name: string, args: JsonValue[], path: string): void {
    const [a, b] = args;
    const bad = (expected: string) => this.note(path, name, `expects ${expected}, got ${JSON.stringify(args)}`);
    const isProp = (v: unknown): v is MotionProperty => (MOTION_PROPERTIES as readonly unknown[]).includes(v);
    switch (name) {
      case "spin":
        if (typeof a === "number" && a >= 100) anim.spin = a;
        else bad("(ms >= 100)");
        return;
      case "frames":
        if (Array.isArray(a) && a.every((f) => typeof f === "string") && typeof b === "number" && b >= 16) {
          anim.frames = [a as string[], b];
        } else bad("(string[], ms >= 16)");
        return;
      case "loop": {
        const loop = typeof b === "object" && b !== null && !Array.isArray(b)
          ? {
            prop: a,
            from: b.from,
            to: b.to,
            period: b.period ?? 1000,
            ...(b.easing === undefined ? {} : { easing: b.easing }),
          }
          : undefined;
        if (isProp(a) && is(LoopAnimationSchema, loop)) anim.loop = loop;
        else bad(`(${MOTION_PROPERTIES.join("|")}, {from, to, period >= 100?, easing?})`);
        return;
      }
      case "transition": {
        const policy = typeof b === "number" ? { duration: b } : b;
        if (isProp(a) && is(TransitionPolicySchema, policy)) {
          anim.transition = [...(anim.transition ?? []).filter(([p]) => p !== a), [a, policy]];
        } else bad(`(${MOTION_PROPERTIES.join("|")}, ms | {duration, delay?, easing?})`);
        return;
      }
      case "spring": {
        const policy = b ?? {};
        if (isProp(a) && is(SpringPolicySchema, policy)) {
          anim.spring = [...(anim.spring ?? []).filter(([p]) => p !== a), [a, policy]];
        } else bad(`(${MOTION_PROPERTIES.join("|")}, {response?, damping?, epsilon?}?)`);
        return;
      }
    }
  }

  private element(rec: RecordedElement, path: string): ElementNode {
    const style: Style = rec.tag === "h_flex" || rec.tag === "v_flex" ? parseStyleName(rec.tag)! : {};
    const attrs: JsonObject = {};
    const anim: Anim = {};
    rec.style.forEach(([name, ...args], i) => {
      const at = jsonPointer(`${path}/style`, i);
      if (this.styleCall(style, name, args, at)) return;
      const kind = Object.hasOwn(BEHAVIOURAL_METHODS, name) ? BEHAVIOURAL_METHODS[name] : undefined;
      switch (kind) {
        case "anim":
          this.anim(anim, name, args, at);
          return;
        case "scroll": {
          const axis = name.includes("_x_") ? "x" : name.includes("_y_") ? "y" : "both";
          if (axis !== "y") style.overflowX = "auto";
          if (axis !== "x") style.overflowY = "auto";
          if (name.endsWith("scrollbar")) attrs.scrollbar = axis;
          return;
        }
        case "attr":
          attrs[name] = args.length === 0 ? true : args.length === 1 ? args[0] : args;
          return;
        case undefined:
          this.note(at, name, "not a gpui-kit element method");
          return;
        default:
          this.note(at, name, `${kind} method recorded as a style call`);
      }
    });

    const states: States = {};
    for (const [name, calls] of Object.entries(rec.states ?? {})) {
      const at = jsonPointer(`${path}/states`, name);
      if (!(REFINEMENTS as readonly string[]).includes(name) || calls === undefined) {
        this.note(at, name, "not a style refinement");
        continue;
      }
      const refined: Style = {};
      calls.forEach(([m, ...args], i) => {
        if (!this.styleCall(refined, m, args, jsonPointer(at, i))) {
          this.note(jsonPointer(at, i), m, "only style methods apply inside a refinement");
        }
      });
      states[name as Refinement] = withBorderStyle(refined);
    }

    const on: Handlers = {};
    rec.handlers.forEach((h, i) => {
      const at = jsonPointer(`${path}/handlers`, i);
      const key = Object.hasOwn(HANDLER_KEYS, h.event) ? HANDLER_KEYS[h.event] : undefined;
      const first = h.args?.[0];
      if (key === undefined) {
        this.note(at, h.event, "not a gpui-kit event handler");
      } else if (key === "mousedown" || key === "mouseup") {
        const button = BUTTONS.find((b) => b === first);
        if (button === undefined) this.note(at, h.event, `expects a mouse button, got ${JSON.stringify(first)}`);
        else on[key] = { ...on[key], [button]: h.id };
      } else if (key === "action") {
        if (typeof first === "string") on.action = { ...on.action, [first]: h.id };
        else this.note(at, h.event, `expects an action name, got ${JSON.stringify(first)}`);
      } else {
        on[key] = h.id;
      }
    });

    const slots: Record<string, ElementNode> = {};
    for (const [name, el] of Object.entries(rec.slots ?? {})) {
      const at = jsonPointer(`${path}/slots`, name);
      if (BEHAVIOURAL_METHODS[name] === "slot") slots[name] = this.element(el, at);
      else this.note(at, name, "not a gpui-kit slot");
    }

    const children = rec.children.map((c, i) => this.node(c, jsonPointer(`${path}/children`, i)));
    const base: ElementNodeBase = typeof rec.id === "string"
      ? { id: rec.id, style: withBorderStyle(style) }
      : { style: withBorderStyle(style) };
    if (Object.keys(states).length > 0) base.states = states;
    if (Object.keys(anim).length > 0) base.anim = anim;
    if (Object.keys(on).length > 0) base.on = on;
    if (Object.keys(attrs).length > 0) base.attrs = attrs;
    if (Object.keys(slots).length > 0) base.slots = slots;
    if (children.length > 0) base.children = children;

    const props = rec.props ?? {};
    const fail = (reason: string): ErrorNode => {
      this.note(path, rec.tag, reason);
      return { k: "error", reason, ...base };
    };
    switch (rec.tag) {
      case "svg":
      case "image":
        return typeof props.src === "string" && props.src.length > 0
          ? { k: rec.tag === "svg" ? "svg" : "image", src: props.src, ...base }
          : fail(`${rec.tag} without a src`);
      case "paint_path":
        return is(PathSpecSchema, props.path) && is(PaintSchema, props.paint)
          ? { k: "path", path: props.path, paint: props.paint, ...base }
          : fail("paint_path needs props.path (PathSpec) and props.paint (colour or Background)");
      case "terminal":
        return typeof props.terminal === "string" && props.terminal.length > 0
          ? { k: "terminal", terminal: props.terminal, ...base }
          : fail("terminal without a terminal id");
    }
    const { state, ...withoutState } = props;
    const { format, ...rest } = withoutState;
    const type: WidgetType | undefined = rec.tag === "TextView"
      ? (format === "markdown" || format === "html" ? format : undefined)
      : Object.hasOwn(WIDGET_TAGS, rec.tag)
      ? WIDGET_TAGS[rec.tag]
      : undefined;
    if (rec.tag === "TextView" && type === undefined) return fail("TextView format must be markdown or html");
    if (type !== undefined) {
      const stateId = typeof state === "string" || typeof state === "number" ? String(state) : rec.id ?? "";
      base.widget = { type, state: stateId, props: rec.tag === "TextView" ? rest : withoutState };
    }
    return { k: "el", tag: rec.tag, ...base };
  }
}

/**
 * Converts one recorded render into the client tree. Every recorded call either maps or is reported in
 * `diagnostics` (unknown or misplaced method, refused argument, malformed factory props); a malformed `svg`/`image`/
 * `paint_path`/`terminal`/`TextView` element becomes a `k:"error"` node in place.
 */
export function toElementTree(root: RecordedTree): ConvertedTree {
  const c = new Converter();
  const tree = c.node(root, "");
  return { tree, diagnostics: c.diagnostics };
}
