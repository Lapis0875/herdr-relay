/**
 * Theme and look. `hello.theme` (Herdr's `theme()`: colour name → `#rrggbb[aa]`) becomes CSS custom properties
 * `--herdr-<name>` on `:root`; names a theme leaves out are derived from `background`/`foreground` so the shell and
 * placeholder views always have a full palette. Dark or light follows `settings.dark` (Herdr's appearance now), else
 * the background's luminance; `<meta name="theme-color">` and `color-scheme` follow. `hello.fonts` sets the three
 * font stacks (D10). Layout nodes' own look (`background`, `radius`, `border`, `padding`, `gap`, `shadow`) maps to
 * inline styles with theme colour names resolved through the same properties.
 */

import type { CSSProperties } from "react";
import type { Fonts, JsonObject, LayoutNode } from "@herdr-relay/protocol";

/** The stacks used before the bridge says otherwise (`src/styles` / fonts manifest families). */
export const DEFAULT_FONTS: Fonts = {
  ui: "Geist, Pretendard, system-ui, sans-serif",
  mono: "'JetBrains Mono', Pretendard, ui-monospace, monospace",
  terminal: "D2Coding, 'JetBrains Mono', ui-monospace, monospace",
};

type Rgb = [number, number, number];

function parseHex(hex: string | undefined): Rgb | null {
  if (!hex) return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1].slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

const toHex = (c: Rgb) =>
  `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

/** `a` moved `t` (0–1) of the way to `b`. */
function mix(a: Rgb, b: Rgb, t: number): string {
  return toHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

/** WCAG relative luminance. */
export function luminance(c: Rgb): number {
  const lin = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** Herdr's full colour set (AGENTS.md `theme()`), filling names the theme leaves out. */
export function completeTheme(theme: Readonly<Record<string, string>>, dark?: boolean): Record<string, string> {
  const t: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme)) if (parseHex(v)) t[k] = v;
  const bg = parseHex(t.background) ?? (dark === false ? [250, 250, 250] as Rgb : [33, 37, 43] as Rgb);
  const isDark = dark ?? luminance(bg) < 0.4;
  const fg = parseHex(t.foreground) ?? (isDark ? [171, 178, 191] as Rgb : [56, 58, 66] as Rgb);
  const black: Rgb = [0, 0, 0];
  const fill = (name: string, value: () => string) => {
    if (!t[name]) t[name] = value();
  };
  fill("background", () => toHex(bg));
  fill("foreground", () => toHex(fg));
  fill("canvas", () => mix(bg, black, isDark ? 0.18 : 0.04));
  fill("chrome", () => mix(bg, black, isDark ? 0.1 : 0.03));
  fill("surface", () => toHex(bg));
  fill("popover", () => mix(bg, fg, 0.06));
  fill("raised", () => mix(bg, fg, 0.08));
  fill("hover", () => mix(bg, fg, 0.1));
  fill("selected", () => t.selection ?? mix(bg, fg, 0.16));
  fill("selection", () => mix(bg, fg, 0.2));
  fill("border", () => mix(bg, fg, 0.18));
  fill("input", () => mix(bg, fg, 0.3));
  fill("muted", () => mix(fg, bg, 0.3));
  fill("dim", () => mix(fg, bg, 0.5));
  fill("accent", () => t.ansi4 ?? (isDark ? "#61afef" : "#3b6fd8"));
  const accent = parseHex(t.accent)!;
  fill("accent_foreground", () => luminance(accent) > 0.45 ? "#111111" : "#ffffff");
  fill("solid", () => t.accent);
  fill("solid_foreground", () => t.accent_foreground);
  fill("working", () => t.ansi4 ?? t.accent);
  fill("blocked", () => t.ansi3 ?? (isDark ? "#e5c07b" : "#b07a00"));
  fill("done", () => t.ansi2 ?? (isDark ? "#98c379" : "#3f8f3a"));
  fill("idle", () => t.muted);
  fill("unknown", () => t.dim);
  fill("danger", () => t.ansi1 ?? (isDark ? "#e06c75" : "#c7303b"));
  return t;
}

let applied: string[] = [];

/** Puts a bridge theme, settings and fonts on `:root`. */
export function applyTheme(theme: Readonly<Record<string, string>>, settings: JsonObject, fonts: Fonts): void {
  const root = document.documentElement;
  const dark = typeof settings.dark === "boolean" ? settings.dark : undefined;
  const colors = completeTheme(theme, dark);
  for (const name of applied) if (!(name in colors)) root.style.removeProperty(`--herdr-${name}`);
  for (const [name, value] of Object.entries(colors)) root.style.setProperty(`--herdr-${name}`, value);
  applied = Object.keys(colors);
  const isDark = dark ?? luminance(parseHex(colors.background)!) < 0.4;
  root.dataset.theme = isDark ? "dark" : "light";
  root.style.colorScheme = isDark ? "dark" : "light";
  root.style.setProperty("--font-ui", fonts.ui);
  root.style.setProperty("--font-mono", fonts.mono);
  root.style.setProperty("--font-terminal", fonts.terminal);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = colors.chrome;
}

/** A layout colour (theme name or hex) as a CSS value. */
export function colorValue(c: unknown): string | undefined {
  if (typeof c !== "string" || c === "") return undefined;
  if (c.startsWith("#")) return parseHex(c) ? c : undefined;
  return /^[a-z][a-z0-9_]*$/i.test(c) ? `var(--herdr-${c})` : undefined;
}

const SHADOWS: Record<string, string> = {
  sm: "0 1px 2px rgb(0 0 0 / 0.18), 0 1px 1px rgb(0 0 0 / 0.1)",
  md: "0 4px 12px rgb(0 0 0 / 0.22), 0 1px 3px rgb(0 0 0 / 0.12)",
  lg: "0 12px 32px rgb(0 0 0 / 0.28), 0 2px 6px rgb(0 0 0 / 0.14)",
};

function spacing(v: unknown): string | undefined {
  if (typeof v === "number") return `${v}px`;
  if (Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every((x) => typeof x === "number")) {
    return v.map((x) => `${x}px`).join(" ");
  }
  return undefined;
}

/**
 * The layout node's own look as inline style. `frame: false` drops radius, border and shadow (a node shown as a
 * whole route or sheet fills the screen; a card frame there would only waste the edges).
 */
export function lookStyle(node: LayoutNode | undefined, frame = true): CSSProperties {
  if (!node) return {};
  const s: CSSProperties = {};
  const bg = colorValue(node.background);
  if (bg) s.background = bg;
  const pad = spacing(node.padding);
  if (pad) s.padding = pad;
  if (typeof node.gap === "number") s.gap = node.gap;
  if (!frame) return s;
  if (typeof node.radius === "number") s.borderRadius = node.radius;
  const border = node.border as { width?: unknown; color?: unknown } | undefined;
  if (border && typeof border.width === "number" && border.width > 0) {
    s.border = `${border.width}px solid ${colorValue(border.color) ?? "var(--herdr-border)"}`;
  }
  if (typeof node.shadow === "string" && SHADOWS[node.shadow]) s.boxShadow = SHADOWS[node.shadow];
  if (s.borderRadius !== undefined) s.overflow = "hidden";
  return s;
}

/** Indexes a layout tree (with its floating entries) by node id. */
export function indexLayout(root: LayoutNode): Map<string, LayoutNode> {
  const out = new Map<string, LayoutNode>();
  const walk = (n: LayoutNode) => {
    if (typeof n.id === "string") out.set(n.id, n);
    for (const c of n.children ?? []) walk(c);
    for (const c of n.floating ?? []) walk(c);
  };
  walk(root);
  return out;
}
