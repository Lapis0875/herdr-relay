/**
 * The look from appHome files (DESIGN.md §5.4: `theme()`, `settings()`, the client fonts of the bridge `hello`): which
 * theme the shown layout uses, its colour names, and the merged settings. AGENTS.md "The look" rules: a layout's own
 * look wins, settings.json fills what it leaves unset, the theme picker (a click) overrides both.
 *
 * [I] Herdr derives the panel colours (`surface`, `chrome`, `border`, …) from a theme file inside the app binary, and
 * its presets (`graphite`, `ink`, `moss`, `paper`) are not files at all. Without the mirror mod (D5), which reports
 * the exact `theme()`, the bridge derives them here by mixing background and foreground, and shows a neutral dark or
 * light palette for a preset. Every explicit `colors` entry (theme file, settings.json, layout) is applied as given.
 */

import type { Fonts, JsonObject, JsonValue, LayoutNode } from "@herdr-relay/protocol";

/** `themes/<name>.json` (AGENTS.md): `#rrggbb` colours; `colors` overrides derived names. */
export interface ThemeFile {
  background: string;
  foreground: string;
  selection?: string;
  cursor?: string;
  ansi?: string[];
  colors?: Record<string, string>;
}

/** Herdr's presets (AGENTS.md "The look"); `paper` is the light one. */
export const PRESET_THEMES: Readonly<Record<string, { light: boolean }>> = {
  graphite: { light: false },
  ink: { light: false },
  moss: { light: false },
  paper: { light: true },
};

/** [I] Neutral stand-ins for a preset, by lightness (the presets' colours live in the app binary). */
const FALLBACK: Readonly<Record<"dark" | "light", ThemeFile>> = {
  dark: {
    background: "#1c1c1f",
    foreground: "#d6d6da",
    selection: "#3a3a42",
    ansi: [
      "#2a2a2e",
      "#e5636b",
      "#8fc67a",
      "#e3bf6f",
      "#6aa8f0",
      "#c084e0",
      "#58bfc9",
      "#c8c8cc",
      "#5c5c64",
      "#f07a82",
      "#a4d68f",
      "#efcd85",
      "#84b8f5",
      "#cf9be8",
      "#72ccd5",
      "#ededf0",
    ],
  },
  light: {
    background: "#fbfbfa",
    foreground: "#2b2b2f",
    selection: "#d8dce6",
    ansi: [
      "#3a3a3f",
      "#c8333d",
      "#3f8a2e",
      "#9a6b00",
      "#2f63c8",
      "#8a3fb0",
      "#1d8591",
      "#c8c8cc",
      "#6b6b72",
      "#d94a53",
      "#4f9c3d",
      "#ad7c0b",
      "#4174d6",
      "#9b52c1",
      "#2a96a2",
      "#ededf0",
    ],
  },
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

function hex(c: Rgb): string {
  return `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** `a` moved towards `b` by `t` (0–1). */
function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Whether a theme is light (its background is light). */
export function isLight(t: ThemeFile): boolean {
  return luminance(t.background) > 0.4;
}

/** A parsed `themes/<name>.json`, or null when it is not one (missing colours, non-hex values). */
export function parseThemeFile(value: unknown): ThemeFile | null {
  if (!isObject(value)) return null;
  const { background, foreground, selection, cursor, ansi, colors } = value;
  if (!isHex(background) || !isHex(foreground)) return null;
  const out: ThemeFile = { background, foreground };
  if (isHex(selection)) out.selection = selection;
  if (isHex(cursor)) out.cursor = cursor;
  if (Array.isArray(ansi) && ansi.length === 16 && ansi.every(isHex)) out.ansi = ansi as string[];
  if (isObject(colors)) out.colors = hexEntries(colors);
  return out;
}

/** Every colour name of `theme()` for one theme file, derived where the file leaves it unset ([I], see above). */
export function themeColors(t: ThemeFile): Record<string, string> {
  const bg = t.background;
  const fg = t.foreground;
  const ansi = t.ansi ?? FALLBACK[isLight(t) ? "light" : "dark"].ansi!;
  const accent = ansi[4];
  const out: Record<string, string> = {
    background: bg,
    foreground: fg,
    cursor: t.cursor ?? fg,
    selection: t.selection ?? mix(bg, fg, 0.22),
    canvas: mix(bg, fg, 0.025),
    surface: mix(bg, fg, 0.05),
    chrome: mix(bg, fg, 0.04),
    popover: mix(bg, fg, 0.07),
    raised: mix(bg, fg, 0.09),
    hover: mix(bg, fg, 0.12),
    selected: mix(bg, fg, 0.17),
    border: mix(bg, fg, 0.2),
    input: mix(bg, fg, 0.24),
    muted: mix(fg, bg, 0.3),
    dim: mix(fg, bg, 0.5),
    accent,
    accent_foreground: Math.abs(luminance(accent) - luminance(bg)) > Math.abs(luminance(accent) - luminance(fg))
      ? bg
      : fg,
    solid: fg,
    solid_foreground: bg,
    ring: accent,
    working: ansi[4],
    blocked: ansi[3],
    done: ansi[2],
    idle: mix(fg, bg, 0.5),
    unknown: mix(fg, bg, 0.5),
  };
  ansi.forEach((c, i) => (out[`ansi${i}`] = c));
  return { ...out, ...t.colors };
}

/** A `theme` look field: a name, or one per appearance (`{light, dark}`). */
function themeName(spec: unknown, appearance: "light" | "dark"): string | null {
  if (typeof spec === "string" && spec !== "") return spec;
  if (isObject(spec)) {
    const pick = spec[appearance];
    if (typeof pick === "string" && pick !== "") return pick;
  }
  return null;
}

export interface ResolvedTheme {
  name: string;
  light: boolean;
  colors: Record<string, string>;
}

/**
 * `theme()` for the shown layout: the theme named by the layout root (clicks applied, so a theme pick wins), else
 * settings.json's, else `graphite`/`paper` by appearance; then `colors` overrides from settings.json and, winning, the
 * layout root. `appearance` is settings.json's; [I] the system's is not visible to the bridge, so dark is assumed.
 */
export function resolveTheme(
  root: LayoutNode,
  settings: JsonObject,
  themes: ReadonlyMap<string, ThemeFile>,
): ResolvedTheme {
  const appearance = settings.appearance === "light" ? "light" : "dark";
  const name = themeName(root.theme, appearance) ?? themeName(settings.theme, appearance) ??
    (appearance === "light" ? "paper" : "graphite");
  const file = themes.get(name);
  const light = file ? isLight(file) : PRESET_THEMES[name]?.light ?? appearance === "light";
  const colors = themeColors(file ?? FALLBACK[light ? "light" : "dark"]);
  Object.assign(colors, hexEntries(settings.colors), hexEntries(root.colors));
  return { name, light, colors };
}

/** Look fields a layout root may set that `settings()` reports (AGENTS.md "The look"). */
const LOOK_KEYS = [
  "font",
  "font_size",
  "ui_font",
  "zoom",
  "terminal_padding",
  "terminal_opacity",
  "background",
  "colors",
] as const;

/**
 * `settings()`: "the shown layout's look (theme name, fonts, sizes, terminal padding and opacity) with the person's
 * zoom and sounds" — settings.json, overridden by the layout root's look fields, with the resolved theme name and
 * `font_family` (the terminal font, as the shipped mods read it; Herdr's default JetBrains Mono).
 */
export function effectiveSettings(settings: JsonObject, root: LayoutNode, theme: string): JsonObject {
  const out: JsonObject = { ...settings };
  for (const key of LOOK_KEYS) {
    if (key !== "zoom" && root[key] !== undefined) out[key] = root[key] as JsonValue;
  }
  out.theme = theme;
  out.zoom = typeof settings.zoom === "number" ? settings.zoom : 1;
  out.font_family = typeof out.font === "string" && out.font !== "" ? out.font : "JetBrains Mono";
  return out;
}

/** The client's CSS font lists (D10, bundled: Geist, Pretendard, JetBrains Mono, D2Coding), the Mac's choice first. */
export function clientFonts(settings: JsonObject): Fonts {
  const own = (v: unknown) => {
    const name = typeof v === "string" ? v.replace(/[^\p{L}\p{N} ._-]/gu, "").trim() : "";
    return name ? `'${name}', ` : "";
  };
  return {
    ui: `${own(settings.ui_font)}Geist, Pretendard, system-ui, sans-serif`,
    mono: "'JetBrains Mono', Pretendard, ui-monospace, monospace",
    terminal: `${own(settings.font)}D2Coding, 'JetBrains Mono', ui-monospace, monospace`,
  };
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isHex(v: unknown): v is string {
  return typeof v === "string" && HEX.test(v);
}

function hexEntries(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, c]) => isHex(c))) as Record<string, string>;
}
