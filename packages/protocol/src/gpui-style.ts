/**
 * GPUI style-method parser: maps the `NativeElement` methods of gpui-kit (gpui-shell 0.7.1, `gpui-kit.d.ts`) to CSS.
 *
 * The d.ts declares 3,308 element methods (DESIGN.md §1.1):
 * - 3,146 generated no-argument style methods (`w_4`, `border_b_2`, `items_center`, …) — parsed by rule from the
 *   Tailwind-style scales below, not looked up in a 3,146-row table (`parseStyleName`);
 * - 59 style methods that take one argument (`bg("#fff")`, `p(8)`, `w("50%")`, …) — `parseArgStyle`, which enforces
 *   the d.ts length types (`p("auto")` and `rounded("50%")` are refused, as the runtime refuses them);
 * - 103 behavioural methods (children, slots, handlers, state refinements, motion, scrolling, accessibility, dock
 *   commands) — classified in `BEHAVIOURAL_METHODS`; `tree.ts` turns them into `ElementNode` fields.
 *
 * Output is a `Style`: camelCase CSS longhand properties (React style-object keys; shorthands are expanded so
 * re-renders never mix a shorthand with its longhands) plus two `--herdr-*` custom properties for GPUI features CSS
 * lacks (`--herdr-text-bg`, `--herdr-ellipsis`). Numbers are CSS pixels, except for the unitless properties
 * `lineHeight` (a multiplier, as in GPUI), `opacity`, `fontWeight`, `flexGrow` and `flexShrink`. A renderer applying a
 * `Style` must default `border-style` to `solid` (GPUI draws a border from its width and colour alone);
 * `tree.ts` adds `borderStyle: "solid"` wherever a border width is set without an explicit style.
 */

import { define, number, record, type Schema, string, union } from "./schema.ts";

export type StyleValue = string | number;
/** CSS declarations for one element (see the module documentation for units). */
export type Style = Record<string, StyleValue>;

export const StyleSchema: Schema<Style> = define(
  "Style",
  () =>
    record(union([string(), number()]), {
      keys: "^(--[a-z0-9-]+|[a-z][A-Za-z]*)$",
      description: "CSS longhands (camelCase) or --herdr-* custom properties; numbers are px except unitless ones",
    }),
);

// ---------------------------------------------------------------------------------------------------------------------
// Scales (values as documented on each generated method in gpui-kit.d.ts: "16px (1rem)", "50% (1/2)", "9999px" …).

/** Spacing steps: `<n>` = n × 4 px (`0p5` = 2 px). */
const SPACING_STEPS = [
  0,
  0.5,
  1,
  1.5,
  2,
  2.5,
  3,
  3.5,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  16,
  20,
  24,
  32,
  40,
  48,
  56,
  64,
  72,
  80,
  96,
  112,
  128,
];
/** Fraction tokens `<a>_<b>` = a/b of the parent. */
const FRACTIONS = [[1, 2], [1, 3], [2, 3], [1, 4], [2, 4], [3, 4], [1, 5], [2, 5], [3, 5], [4, 5], [1, 6], [5, 6], [
  1,
  12,
]];

const SPACING: Record<string, StyleValue> = Object.fromEntries<StyleValue>([
  ...SPACING_STEPS.map((n): [string, StyleValue] => [String(n).replace(".", "p"), n * 4]),
  ...FRACTIONS.map(([a, b]): [string, StyleValue] => [`${a}_${b}`, `${Number(((a / b) * 100).toFixed(4))}%`]),
  ["px", 1],
  ["full", "100%"],
]);

const BORDER_WIDTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 20, 24, 32];

const RADII: Record<string, number> = { none: 0, xs: 2, sm: 4, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24, full: 9999 };

const SIDES4 = ["Top", "Right", "Bottom", "Left"];

/** Spacing families: the generated `<family>_[neg_]<token>` names and the arg method `<family>(value)` share them. */
const SPACING_FAMILIES: Record<string, { props: readonly string[]; auto: boolean; arg: "length" | "definite" }> = {
  w: { props: ["width"], auto: true, arg: "length" },
  h: { props: ["height"], auto: true, arg: "length" },
  size: { props: ["width", "height"], auto: true, arg: "length" },
  min_w: { props: ["minWidth"], auto: true, arg: "length" },
  min_h: { props: ["minHeight"], auto: true, arg: "length" },
  min_size: { props: ["minWidth", "minHeight"], auto: true, arg: "length" },
  max_w: { props: ["maxWidth"], auto: true, arg: "length" },
  max_h: { props: ["maxHeight"], auto: true, arg: "length" },
  max_size: { props: ["maxWidth", "maxHeight"], auto: true, arg: "length" },
  m: { props: SIDES4.map((s) => `margin${s}`), auto: true, arg: "length" },
  mt: { props: ["marginTop"], auto: true, arg: "length" },
  mr: { props: ["marginRight"], auto: true, arg: "length" },
  mb: { props: ["marginBottom"], auto: true, arg: "length" },
  ml: { props: ["marginLeft"], auto: true, arg: "length" },
  mx: { props: ["marginLeft", "marginRight"], auto: true, arg: "length" },
  my: { props: ["marginTop", "marginBottom"], auto: true, arg: "length" },
  p: { props: SIDES4.map((s) => `padding${s}`), auto: false, arg: "definite" },
  pt: { props: ["paddingTop"], auto: false, arg: "definite" },
  pr: { props: ["paddingRight"], auto: false, arg: "definite" },
  pb: { props: ["paddingBottom"], auto: false, arg: "definite" },
  pl: { props: ["paddingLeft"], auto: false, arg: "definite" },
  px: { props: ["paddingLeft", "paddingRight"], auto: false, arg: "definite" },
  py: { props: ["paddingTop", "paddingBottom"], auto: false, arg: "definite" },
  gap: { props: ["rowGap", "columnGap"], auto: false, arg: "definite" },
  gap_x: { props: ["columnGap"], auto: false, arg: "definite" },
  gap_y: { props: ["rowGap"], auto: false, arg: "definite" },
  inset: { props: ["top", "right", "bottom", "left"], auto: true, arg: "length" },
  top: { props: ["top"], auto: true, arg: "length" },
  right: { props: ["right"], auto: true, arg: "length" },
  bottom: { props: ["bottom"], auto: true, arg: "length" },
  left: { props: ["left"], auto: true, arg: "length" },
};

/** `border[_<side>]`: the generated `border[_<side>]_<width>` names and the arg methods `border[_<side>](width)`. */
const BORDER_SIDES: Record<string, readonly string[]> = {
  "": SIDES4.map((s) => `border${s}Width`),
  t: ["borderTopWidth"],
  r: ["borderRightWidth"],
  b: ["borderBottomWidth"],
  l: ["borderLeftWidth"],
  x: ["borderLeftWidth", "borderRightWidth"],
  y: ["borderTopWidth", "borderBottomWidth"],
};

/** `rounded[_<corners>]`: the generated `rounded[_<corners>]_<size>` names and the arg methods. */
const CORNERS: Record<string, readonly string[]> = {
  "": ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"],
  t: ["borderTopLeftRadius", "borderTopRightRadius"],
  r: ["borderTopRightRadius", "borderBottomRightRadius"],
  b: ["borderBottomRightRadius", "borderBottomLeftRadius"],
  l: ["borderTopLeftRadius", "borderBottomLeftRadius"],
  tl: ["borderTopLeftRadius"],
  tr: ["borderTopRightRadius"],
  br: ["borderBottomRightRadius"],
  bl: ["borderBottomLeftRadius"],
};

const CURSORS = [
  "alias",
  "col_resize",
  "context_menu",
  "copy",
  "crosshair",
  "default",
  "e_resize",
  "ew_resize",
  "grab",
  "grabbing",
  "move",
  "n_resize",
  "nesw_resize",
  "no_drop",
  "not_allowed",
  "ns_resize",
  "nwse_resize",
  "pointer",
  "row_resize",
  "s_resize",
  "text",
  "vertical_text",
  "w_resize",
];

/** GPUI's box shadows (Tailwind scale). */
const SHADOWS: Record<string, string> = {
  "2xs": "0 1px 0 0 rgb(0 0 0 / 0.05)",
  xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  sm: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
  md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
  "2xl": "0 25px 50px -12px rgb(0 0 0 / 0.25)",
  none: "none",
};

const ALIGN: Record<string, string> = {
  start: "flex-start",
  end: "flex-end",
  flex_start: "flex-start",
  flex_end: "flex-end",
  center: "center",
  baseline: "baseline",
  stretch: "stretch",
  normal: "normal",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
};

const family = (prefix: string, property: string, values: Record<string, StyleValue>): [string, Style][] =>
  Object.entries(values).map(([k, v]) => [`${prefix}${k}`, { [property]: v }]);

const pick = (keys: string[]): Record<string, string> => Object.fromEntries(keys.map((k) => [k, ALIGN[k]]));

/** Generated names that are not part of a numeric scale. */
const FIXED: Record<string, Style> = Object.fromEntries<Style>([
  ["absolute", { position: "absolute" }],
  ["relative", { position: "relative" }],
  ["block", { display: "block" }],
  ["flex", { display: "flex" }],
  ["grid", { display: "grid" }],
  ["hidden", { display: "none" }],
  ["visible", { visibility: "visible" }],
  ["invisible", { visibility: "hidden" }],
  ["h_flex", { display: "flex", flexDirection: "row", alignItems: "center" }],
  ["v_flex", { display: "flex", flexDirection: "column" }],
  ["aspect_square", { aspectRatio: "1 / 1" }],
  ["italic", { fontStyle: "italic" }],
  ["not_italic", { fontStyle: "normal" }],
  ["underline", { textDecorationLine: "underline" }],
  ["line_through", { textDecorationLine: "line-through" }],
  ["truncate", { overflowX: "hidden", overflowY: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }],
  ["border_dashed", { borderStyle: "dashed" }],
  ["overflow_hidden", { overflowX: "hidden", overflowY: "hidden" }],
  ["overflow_x_hidden", { overflowX: "hidden" }],
  ["overflow_y_hidden", { overflowY: "hidden" }],
  ["whitespace_normal", { whiteSpace: "normal" }],
  ["whitespace_nowrap", { whiteSpace: "nowrap" }],
  ["col_span_full", { gridColumn: "1 / -1" }],
  ["col_start_auto", { gridColumnStart: "auto" }],
  ["col_end_auto", { gridColumnEnd: "auto" }],
  ["row_span_full", { gridRow: "1 / -1" }],
  ["row_start_auto", { gridRowStart: "auto" }],
  ["row_end_auto", { gridRowEnd: "auto" }],
  ["flex_1", { flexGrow: 1, flexShrink: 1, flexBasis: "0%" }],
  ["flex_auto", { flexGrow: 1, flexShrink: 1, flexBasis: "auto" }],
  ["flex_initial", { flexGrow: 0, flexShrink: 1, flexBasis: "auto" }],
  ["flex_none", { flexGrow: 0, flexShrink: 0, flexBasis: "auto" }],
  ["flex_grow_0", { flexGrow: 0 }],
  ["flex_grow_1", { flexGrow: 1 }],
  ["flex_shrink_0", { flexShrink: 0 }],
  ["flex_shrink_1", { flexShrink: 1 }],
  ...family("flex_", "flexDirection", {
    row: "row",
    row_reverse: "row-reverse",
    col: "column",
    col_reverse: "column-reverse",
  }),
  ...family("flex_", "flexWrap", { wrap: "wrap", wrap_reverse: "wrap-reverse", nowrap: "nowrap" }),
  ...family("items_", "alignItems", pick(["start", "end", "center", "baseline", "stretch"])),
  ...family("justify_", "justifyContent", pick(["start", "end", "center", "between", "around", "evenly"])),
  ...family(
    "content_",
    "alignContent",
    pick(["normal", "center", "start", "end", "between", "around", "evenly", "stretch"]),
  ),
  ...family("self_", "alignSelf", pick(["start", "end", "flex_start", "flex_end", "center", "baseline", "stretch"])),
  ...family("cursor_", "cursor", Object.fromEntries(CURSORS.map((c) => [c, c.replaceAll("_", "-")]))),
  ...family("font_", "fontWeight", {
    thin: 100,
    extralight: 200,
    light: 300,
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    extrabold: 800,
    black: 900,
  }),
  ...family("text_", "fontSize", { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, "2xl": 24, "3xl": 30 }),
  ...family("text_", "textAlign", { left: "left", center: "center", right: "right" }),
  ["text_ellipsis", { textOverflow: "ellipsis" }],
  ["text_ellipsis_start", { textOverflow: "ellipsis", "--herdr-ellipsis": "start" }],
  ["text_ellipsis_middle", { textOverflow: "ellipsis", "--herdr-ellipsis": "middle" }],
  ...family("text_decoration_", "textDecorationThickness", { 0: 0, 1: 1, 2: 2, 4: 4, 8: 8 }),
  ["text_decoration_none", { textDecorationLine: "none" }],
  ["text_decoration_solid", { textDecorationStyle: "solid" }],
  ["text_decoration_wavy", { textDecorationStyle: "wavy" }],
  ...family("shadow_", "boxShadow", SHADOWS),
  ...family("debug_", "outline", {
    red: "1px solid red",
    green: "1px solid green",
    blue: "1px solid blue",
    yellow: "1px solid yellow",
    pink: "1px solid pink",
  }),
]);

const assign = (props: readonly string[], value: StyleValue): Style => Object.fromEntries(props.map((p) => [p, value]));

function parseSpacing(name: string): Style | undefined {
  const parts = name.split("_");
  const two = parts.length > 2 ? `${parts[0]}_${parts[1]}` : undefined;
  const famName = two !== undefined && Object.hasOwn(SPACING_FAMILIES, two)
    ? two
    : Object.hasOwn(SPACING_FAMILIES, parts[0])
    ? parts[0]
    : undefined;
  if (famName === undefined) return undefined;
  const fam = SPACING_FAMILIES[famName];
  const rest = name.slice(famName.length + 1);
  if (rest.startsWith("neg_")) {
    const token = rest.slice(4);
    if (!Object.hasOwn(SPACING, token)) return undefined;
    const v = SPACING[token];
    return assign(fam.props, typeof v === "number" ? (v === 0 ? 0 : -v) : `-${v}`);
  }
  if (rest === "auto") return fam.auto ? assign(fam.props, "auto") : undefined;
  return Object.hasOwn(SPACING, rest) ? assign(fam.props, SPACING[rest]) : undefined;
}

function parseBorder(name: string): Style | undefined {
  const m = /^border(?:_([trblxy]))?_(\d+)$/.exec(name);
  if (m === null || !BORDER_WIDTHS.includes(Number(m[2]))) return undefined;
  return assign(BORDER_SIDES[m[1] ?? ""], Number(m[2]));
}

function parseRounded(name: string): Style | undefined {
  const m = /^rounded(?:_(tl|tr|bl|br|[trbl]))?_([a-z0-9]+)$/.exec(name);
  if (m === null || !Object.hasOwn(RADII, m[2])) return undefined;
  return assign(CORNERS[m[1] ?? ""], RADII[m[2]]);
}

/**
 * The CSS for a generated no-argument style method (`w_4`, `rounded_t_md`, `items_center`), or `undefined` when
 * `name` is not one of the 3,146 generated names. Returns a fresh object.
 */
export function parseStyleName(name: string): Style | undefined {
  if (Object.hasOwn(FIXED, name)) return { ...FIXED[name] };
  return parseSpacing(name) ?? parseBorder(name) ?? parseRounded(name);
}

// ---------------------------------------------------------------------------------------------------------------------
// Argument style methods.

/** The d.ts parameter type of an argument style method. */
export type StyleArgKind =
  | "length" // number | `${n}px` | `${n}rem` | `${n}%` | "auto"
  | "definite" // number | `${n}px` | `${n}rem` | `${n}%`
  | "absolute" // number | `${n}px` | `${n}rem`
  | "lineHeight" // DefiniteLength; a bare number is a multiplier
  | "color" // `#rgb` | `#rrggbb` | `#rrggbbaa`
  | "fontWeight" // 100..900
  | "unit" // 0..1
  | "nonNegative" // number >= 0
  | "string";

type ArgSpec = { kind: StyleArgKind; props: readonly string[] };

const ARG_SPECS: Record<string, ArgSpec> = Object.fromEntries<ArgSpec>([
  ...Object.entries(SPACING_FAMILIES).map(([name, f]): [string, ArgSpec] => [name, { kind: f.arg, props: f.props }]),
  ...Object.entries(BORDER_SIDES).map(([side, props]): [string, ArgSpec] => [
    side ? `border_${side}` : "border",
    { kind: "absolute", props },
  ]),
  ...Object.entries(CORNERS).map(([c, props]): [string, ArgSpec] => [
    c ? `rounded_${c}` : "rounded",
    { kind: "absolute", props },
  ]),
  ["bg", { kind: "color", props: ["backgroundColor"] }],
  ["border_color", { kind: "color", props: ["borderColor"] }],
  ["text_color", { kind: "color", props: ["color"] }],
  ["text_bg", { kind: "color", props: ["--herdr-text-bg"] }],
  ["text_size", { kind: "absolute", props: ["fontSize"] }],
  ["line_height", { kind: "lineHeight", props: ["lineHeight"] }],
  ["font_family", { kind: "string", props: ["fontFamily"] }],
  ["font_weight", { kind: "fontWeight", props: ["fontWeight"] }],
  ["opacity", { kind: "unit", props: ["opacity"] }],
  ["flex_basis", { kind: "length", props: ["flexBasis"] }],
  ["flex_grow", { kind: "nonNegative", props: ["flexGrow"] }],
  ["flex_shrink", { kind: "nonNegative", props: ["flexShrink"] }],
]);

/** The 59 style methods that take one argument, with their d.ts parameter type. */
export const ARG_STYLE_METHODS: Readonly<Record<string, StyleArgKind>> = Object.freeze(
  Object.fromEntries(Object.entries(ARG_SPECS).map(([name, spec]) => [name, spec.kind])),
);

const NUMERIC = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?`;
const PX = new RegExp(`^(${NUMERIC})px$`);
const REM = new RegExp(`^${NUMERIC}rem$`);
const PERCENT = new RegExp(`^${NUMERIC}%$`);
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** The CSS value for `value` under a d.ts parameter type, or a reason it is refused. */
function argValue(kind: StyleArgKind, value: unknown): StyleValue | { error: string } {
  const finite = typeof value === "number" && Number.isFinite(value);
  switch (kind) {
    case "length":
    case "definite":
    case "absolute":
    case "lineHeight": {
      if (finite) return value;
      if (typeof value === "string") {
        const px = PX.exec(value);
        if (px !== null) return kind === "lineHeight" ? value : Number(px[1]);
        if (REM.test(value)) return value;
        if (PERCENT.test(value) && kind !== "absolute") return value;
        if (value === "auto" && kind === "length") return value;
      }
      const accepted = {
        length: 'a number or a px/rem/% length or "auto"',
        definite: "a number or a px/rem/% length",
        lineHeight: "a number or a px/rem/% length",
        absolute: "a number or a px/rem length",
      }[kind];
      return { error: `expects ${accepted}, got ${JSON.stringify(value)}` };
    }
    case "color":
      return typeof value === "string" && COLOR.test(value)
        ? value
        : { error: `expects a #rgb, #rrggbb or #rrggbbaa colour, got ${JSON.stringify(value)}` };
    case "fontWeight":
      return finite && value >= 100 && value <= 900
        ? value
        : { error: `expects a number from 100 to 900, got ${JSON.stringify(value)}` };
    case "unit":
      return finite && value >= 0 && value <= 1
        ? value
        : { error: `expects a number from 0 to 1, got ${JSON.stringify(value)}` };
    case "nonNegative":
      return finite && value >= 0 ? value : { error: `expects a number >= 0, got ${JSON.stringify(value)}` };
    case "string":
      return typeof value === "string" && value.length > 0
        ? value
        : { error: `expects a non-empty string, got ${JSON.stringify(value)}` };
  }
}

export type StyleResult = { ok: true; style: Style } | { ok: false; error: string };

/** The CSS for an argument style method call `name(value)` (`p(8)`, `w("50%")`, `bg("#1e2227")`). */
export function parseArgStyle(name: string, value: unknown): StyleResult {
  if (!Object.hasOwn(ARG_SPECS, name)) return { ok: false, error: `${name} is not an argument style method` };
  const spec = ARG_SPECS[name];
  const v = argValue(spec.kind, value);
  if (typeof v === "object") return { ok: false, error: `${name}: ${v.error}` };
  return { ok: true, style: assign(spec.props, v) };
}

/** The CSS for one recorded style call `[name, ...args]`: a generated name with no arguments, or an arg method. */
export function parseStyleCall(name: string, args: readonly unknown[]): StyleResult {
  if (Object.hasOwn(ARG_SPECS, name)) {
    return args.length === 1
      ? parseArgStyle(name, args[0])
      : { ok: false, error: `${name} takes 1 argument, got ${args.length}` };
  }
  const style = parseStyleName(name);
  if (style === undefined) return { ok: false, error: `${name} is not a GPUI style method` };
  return args.length === 0
    ? { ok: true, style }
    : { ok: false, error: `${name} takes no arguments, got ${args.length}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// Behavioural methods.

/**
 * What a non-style `NativeElement` method is, for `tree.ts`:
 * `tree` (children / ids / combinators, evaluated by the host), `slot` (a named child element), `handler` (an event
 * listener → `on`), `refine` (a style refinement → `states`), `anim` (native motion → `anim`), `scroll` (overflow
 * scrolling → `style` + `attrs.scrollbar`), `attr` (everything else → `attrs`).
 */
export type BehaviourKind = "tree" | "slot" | "handler" | "refine" | "anim" | "scroll" | "attr";

const BEHAVIOURS: Record<BehaviourKind, readonly string[]> = {
  tree: ["map", "child", "children", "when", "id"],
  slot: [
    "content",
    "image",
    "fallback",
    "header",
    "footer",
    "panel",
    "trigger",
    "input",
    "decrement_button",
    "increment_button",
  ],
  handler: [
    "on_click",
    "on_mouse_move",
    "on_size_change",
    "on_hover",
    "on_key_down",
    "on_key_up",
    "on_modifiers_changed",
    "on_mouse_down",
    "on_mouse_up",
    "on_mouse_down_out",
    "on_drop",
    "on_scroll_wheel",
    "on_action",
    "on_item_click",
    "on_item_secondary_click",
    "on_change",
    "on_step",
    "on_open_change",
    "on_confirm",
    "on_dismiss",
    "on_resize",
    "on_token_click",
    "on_token_hover",
  ],
  refine: ["hover", "active", "focus", "range_style", "cell_style", "cell_active_style", "caret_style"],
  anim: ["transition", "spring", "frames", "loop", "spin"],
  scroll: [
    "overflow_scroll",
    "overflow_x_scroll",
    "overflow_y_scroll",
    "overflow_scrollbar",
    "overflow_x_scrollbar",
    "overflow_y_scrollbar",
  ],
  attr: [
    "controls_right",
    "key_context",
    "aria_level",
    "keep_mounted",
    "tooltip",
    "disabled",
    "selected",
    "set_position",
    "checked",
    "pressed",
    "value",
    "indeterminate",
    "accessibility_label",
    "role",
    "aria_selected",
    "aria_active_descendant",
    "track_focus",
    "track_scroll",
    "with_item_to_measure_index",
    "content_focus_handle",
    "tab_index",
    "tab_stop",
    "href",
    "mode",
    "scroll_size",
    "viewport_from_layout",
    "size_range",
    "axis",
    "row_count",
    "column_count",
    "open",
    "default_open",
    "overlay_closable",
    "anchor",
    "frame_budget",
    "mouse_button",
    "open_delay",
    "close_delay",
    "start",
    "select_tab",
    "close_panel",
    "toggle_zoom",
    "drag_tab",
    "drop_tab",
    "toggle_dock",
    "resize_dock",
    "token",
  ],
};

/** The 103 behavioural `NativeElement` methods and what each is. */
export const BEHAVIOURAL_METHODS: Readonly<Record<string, BehaviourKind>> = Object.freeze(
  Object.fromEntries<BehaviourKind>(
    (Object.entries(BEHAVIOURS) as [BehaviourKind, readonly string[]][]).flatMap(([kind, names]) =>
      names.map((n): [string, BehaviourKind] => [n, kind])
    ),
  ),
);

/** Which of the three `NativeElement` method groups `name` belongs to, or `undefined` for an unknown name. */
export function styleMethodKind(name: string): "generated" | "arg" | "behaviour" | undefined {
  if (Object.hasOwn(ARG_SPECS, name)) return "arg";
  if (Object.hasOwn(BEHAVIOURAL_METHODS, name)) return "behaviour";
  return parseStyleName(name) === undefined ? undefined : "generated";
}

/**
 * Applies declarations to `target` in call order (a later call wins, as in GPUI), except that `underline` and
 * `line_through` combine in `textDecorationLine` as GPUI's separate underline and strikethrough do.
 */
export function mergeStyle(target: Style, declarations: Readonly<Style>): Style {
  for (const [k, v] of Object.entries(declarations)) {
    const prev = target[k];
    if (k === "textDecorationLine" && typeof prev === "string" && prev !== "none" && v !== "none") {
      const tokens = new Set([...prev.split(" "), ...String(v).split(" ")]);
      target[k] = [...tokens].join(" ");
    } else {
      target[k] = v;
    }
  }
  return target;
}
