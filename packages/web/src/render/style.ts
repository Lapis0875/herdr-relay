/**
 * `Style` (camelCase CSS longhands from `gpui-style.ts`) → React inline styles, plus what inline styles cannot carry:
 *
 * - GPUI defaults CSS does not share live in `render.css` (`position: relative` and border-box on every element, text
 *   whitespace kept as written). Here `white-space` is translated the same way: GPUI never collapses spaces, so
 *   `normal` is `pre-wrap` and `nowrap` is `pre`.
 * - `states` (hover/active/focus refinements) become one generated class per distinct refinement set, whose rules
 *   (`!important`, so they beat the inline base style, in GPUI's order focus → hover → active) are inserted once into
 *   a shared stylesheet. Hover rules apply only where the primary pointer can hover.
 * - `anim` (native motion) becomes CSS animations and transitions over the keyframes in `render.css`.
 *
 * Values that would load something (`url(`) or end a declaration are dropped: mod styles never need them.
 */

import type { CSSProperties } from "react";
import type { Anim, MotionEasing, States, Style, StyleValue } from "@herdr-relay/protocol";

const KEY = /^(--[a-z0-9-]+|[a-z][A-Za-z]*)$/;
const UNSAFE = /url\(|image-set\(|expression\(|[;{}<>\\]/i;
/** Properties whose numbers carry no unit (`gpui-style.ts`), plus the CSS ones React also leaves bare. */
const UNITLESS: Record<string, true> = {
  lineHeight: true,
  opacity: true,
  fontWeight: true,
  flexGrow: true,
  flexShrink: true,
  zIndex: true,
  order: true,
};

export interface NodeCss {
  style: CSSProperties;
  /** Space-separated classes the style needs (`r-ellipsis-start` …); `""` for none. */
  className: string;
}

function safe(key: string, value: unknown): value is StyleValue {
  if (!KEY.test(key)) return false;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && !UNSAFE.test(value);
}

/** GPUI's whitespace never collapses; GPUI names one font family, and the device may not have it. */
function translate(key: string, value: StyleValue): StyleValue {
  if (key === "whiteSpace") return value === "nowrap" ? "pre" : value === "normal" ? "pre-wrap" : value;
  if (key !== "fontFamily") return value;
  const family = String(value).replace(/["'\\]/g, "").trim();
  return family ? `"${family}", var(--font-ui, system-ui), sans-serif` : "var(--font-ui, system-ui), sans-serif";
}

const cssCache = new WeakMap<Style, NodeCss>();
const EMPTY: NodeCss = { style: {}, className: "" };

/** The inline style and helper classes of a node's `style`. Cached per style object (patches keep untouched ones). */
export function nodeCss(style: Style | undefined): NodeCss {
  if (style === undefined || style === null || typeof style !== "object") return EMPTY;
  const hit = cssCache.get(style);
  if (hit) return hit;
  const out: Record<string, StyleValue> = {};
  const classes: string[] = [];
  for (const [key, value] of Object.entries(style)) {
    if (!safe(key, value)) continue;
    if (key === "--herdr-ellipsis") {
      // CSS truncates only at the end; `start` is emulated, `middle` keeps the end ellipsis.
      if (value === "start") classes.push("r-ellipsis-start");
      continue;
    }
    out[key] = translate(key, value);
  }
  const css: NodeCss = { style: out as CSSProperties, className: classes.join(" ") };
  cssCache.set(style, css);
  return css;
}

// ---------------------------------------------------------------------------------------------------------------------
// Refinement states.

/** GPUI applies refinements in this order, each over the previous (`Interactivity::compute_style`). */
const STATE_SELECTORS = [["focus", ":focus"], ["hover", ":hover"], ["active", ":active"]] as const;

function declarations(style: Style): string {
  const out: string[] = [];
  for (const [key, raw] of Object.entries(style)) {
    if (!safe(key, raw) || key === "--herdr-ellipsis") continue;
    const custom = key.startsWith("--");
    const value = translate(key, raw);
    const text = typeof value === "number" && !custom && !Object.hasOwn(UNITLESS, key) ? `${value}px` : value;
    const name = custom ? key : key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    out.push(`${name}: ${text} !important;`);
  }
  return out.join(" ");
}

/** FNV-1a, base 36: a short stable class suffix (stable across runs, so snapshots of the markup are too). */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

let sheet: CSSStyleSheet | null | undefined;

function stateSheet(): CSSStyleSheet | null {
  if (sheet !== undefined) return sheet;
  if (typeof document === "undefined") return null;
  const el = document.createElement("style");
  el.dataset.herdrRender = "states";
  document.head.append(el);
  sheet = el.sheet;
  return sheet;
}

/** Refinement rules already inserted: their text → class; and every class handed out. */
const stateClasses = new Map<string, string>();
const usedClasses = new Set<string>();
const statesCache = new WeakMap<States, string>();

/** The class carrying a node's hover/active/focus refinements, or `""` when it has none. */
export function stateClass(states: States | undefined): string {
  if (states === undefined || states === null || typeof states !== "object") return "";
  const cached = statesCache.get(states);
  if (cached !== undefined) return cached;
  const parts = STATE_SELECTORS.map(([name]) => {
    const s = states[name];
    return s && typeof s === "object" ? declarations(s) : "";
  });
  let cls = "";
  if (parts.some((p) => p !== "")) {
    const key = parts.join("\n");
    cls = stateClasses.get(key) ?? "";
    if (!cls) {
      cls = `r-st-${hash(key)}`;
      while (usedClasses.has(cls)) cls += "x";
      usedClasses.add(cls);
      stateClasses.set(key, cls);
      const target = stateSheet();
      STATE_SELECTORS.forEach(([, pseudo], i) => {
        if (!target || !parts[i]) return;
        const rule = `.${cls}${pseudo} { ${parts[i]} }`;
        try {
          target.insertRule(pseudo === ":hover" ? `@media (hover: hover) { ${rule} }` : rule, target.cssRules.length);
        } catch {
          // A value the browser does not parse: that refinement is not drawn, the rest is.
        }
      });
    }
  }
  statesCache.set(states, cls);
  return cls;
}

// ---------------------------------------------------------------------------------------------------------------------
// Native motion.

const MOTION: Record<string, true> = { opacity: true, width: true, height: true, left: true, top: true };
const EASINGS: Record<MotionEasing, true> = { linear: true, "ease-in": true, "ease-out": true, "ease-in-out": true };
/** Approximates GPUI's spring with a transition: settled, or overshooting when underdamped. */
const SPRING_SETTLE = "cubic-bezier(0.2, 0, 0, 1)";
const SPRING_BOUNCE = "cubic-bezier(0.34, 1.4, 0.64, 1)";
const SPRING_MS = 350;

const ms = (
  v: unknown,
  min: number,
): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min ? v : null);
/** The policy's easing; unset, gpui-shell's documented default (`LoopPolicy`: ease-in-out) for loops and transitions. */
const easing = (v: unknown): MotionEasing =>
  typeof v === "string" && Object.hasOwn(EASINGS, v) ? v as MotionEasing : "ease-in-out";
/** `[prop, policy]` pairs of a motion list, skipping malformed entries. */
function pairs<P>(list: unknown): [string, P | undefined][] {
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is [string, P | undefined] =>
    Array.isArray(e) && typeof e[0] === "string" && Object.hasOwn(MOTION, e[0])
  );
}

const animCache = new WeakMap<Anim, NodeCss>();

/** `spin`, `loop`, `transition` and `spring` as CSS (`frames` is drawn by the node: it replaces the text). */
export function animCss(anim: Anim | undefined): NodeCss {
  if (anim === undefined || anim === null || typeof anim !== "object") return EMPTY;
  const hit = animCache.get(anim);
  if (hit) return hit;
  const style: Record<string, string> = {};
  const classes: string[] = [];
  const animations: string[] = [];
  const spin = ms(anim.spin, 100);
  if (spin !== null) {
    animations.push(`herdr-r-spin ${spin}ms linear infinite`);
    classes.push("r-anim-spin");
  }
  const loop = anim.loop;
  const period = ms(loop?.period, 100);
  if (
    loop && Object.hasOwn(MOTION, loop.prop) && period !== null && Number.isFinite(loop.from) &&
    Number.isFinite(loop.to)
  ) {
    // `period` is there and back (gpui-shell `LoopPolicy`); the keyframes reach `to` halfway.
    const unit = loop.prop === "opacity" ? "" : "px";
    animations.push(`herdr-r-loop-${loop.prop} ${period}ms ${easing(loop.easing)} infinite`);
    style["--herdr-loop-from"] = `${loop.from}${unit}`;
    style["--herdr-loop-to"] = `${loop.to}${unit}`;
    classes.push("r-anim-loop");
  }
  if (animations.length) style.animation = animations.join(", ");
  const transitions = new Map<string, string>();
  for (const [prop, policy] of pairs<{ duration?: unknown; delay?: unknown; easing?: unknown }>(anim.transition)) {
    const duration = ms(policy?.duration, 0);
    if (duration === null) continue;
    transitions.set(prop, `${prop} ${duration}ms ${easing(policy?.easing)} ${ms(policy?.delay, 0) ?? 0}ms`);
  }
  for (const [prop, policy] of pairs<{ response?: unknown; damping?: unknown }>(anim.spring)) {
    if (transitions.has(prop)) continue;
    const response = ms(policy?.response, 1) ?? SPRING_MS;
    const bounce = typeof policy?.damping === "number" && policy.damping < 1;
    transitions.set(prop, `${prop} ${response}ms ${bounce ? SPRING_BOUNCE : SPRING_SETTLE}`);
  }
  if (transitions.size) {
    style.transition = [...transitions.values()].join(", ");
    classes.push("r-anim-tr");
  }
  const css: NodeCss = { style: style as CSSProperties, className: classes.join(" ") };
  animCache.set(anim, css);
  return css;
}
