/**
 * `k:"path"` (gpui-kit `window.paint_path`): the recorded `PathBuilder` ops as SVG path data, painted over the
 * element's own box with a colour or a `Background`. Coordinates are px or `"<n>%"` of that box, so the element is
 * measured first. Fills use GPUI's (lyon's) default even-odd rule; strokes keep lyon's butt caps and miter joins,
 * which are SVG's defaults too. `arc_to`'s rotation is in radians, as GPUI's `Radians`.
 */

import { type ReactElement, type ReactNode, useId, useLayoutEffect, useState } from "react";
import type { Paint, PathNode } from "@herdr-relay/protocol";
import { useElement } from "./interact.ts";

const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PERCENT = /^(-?(?:\d+(?:\.\d+)?|\.\d+))%$/;

const round = (n: number) => Math.round(n * 1000) / 1000;

function coord(v: unknown, extent: number): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? round(v) : null;
  const m = typeof v === "string" ? PERCENT.exec(v) : null;
  return m ? round((Number(m[1]) / 100) * extent) : null;
}

/** SVG path data for `ops` in a `w`×`h` box, plus its dash pattern; `null` when an op is malformed. */
export function pathData(ops: unknown, w: number, h: number): { d: string; dash: number[] | null } | null {
  if (!Array.isArray(ops)) return null;
  const out: string[] = [];
  let dash: number[] | null = null;
  for (const op of ops) {
    if (!Array.isArray(op)) return null;
    const [name, ...a] = op;
    const pt = (i: number): string | null => {
      const x = coord(a[i], w);
      const y = coord(a[i + 1], h);
      return x === null || y === null ? null : `${x} ${y}`;
    };
    let part: string | null;
    switch (name) {
      case "move_to":
      case "line_to": {
        const to = pt(0);
        part = to && `${name === "move_to" ? "M" : "L"} ${to}`;
        break;
      }
      case "curve_to": {
        const [to, ctrl] = [pt(0), pt(2)];
        part = to && ctrl && `Q ${ctrl} ${to}`;
        break;
      }
      case "cubic_bezier_to": {
        const [to, ca, cb] = [pt(0), pt(2), pt(4)];
        part = to && ca && cb && `C ${ca} ${cb} ${to}`;
        break;
      }
      case "arc_to": {
        const [rx, ry, rot, large, sweep, to] = [coord(a[0], w), coord(a[1], h), a[2], a[3], a[4], pt(5)];
        const deg = typeof rot === "number" && Number.isFinite(rot) ? round((rot * 180) / Math.PI) : null;
        part = rx !== null && ry !== null && deg !== null && to
          ? `A ${Math.abs(rx)} ${Math.abs(ry)} ${deg} ${large ? 1 : 0} ${sweep ? 1 : 0} ${to}`
          : null;
        break;
      }
      case "add_polygon": {
        const points = Array.isArray(a[0]) ? a[0] : [];
        const xy = points.map((p) => {
          if (!Array.isArray(p)) return null;
          const [x, y] = [coord(p[0], w), coord(p[1], h)];
          return x === null || y === null ? null : `${x} ${y}`;
        });
        if (xy.length === 0 || xy.includes(null)) return null;
        part = `M ${xy.join(" L ")}${a[1] === false ? "" : " Z"}`;
        break;
      }
      case "close":
        part = "Z";
        break;
      case "dash_array": {
        const values = Array.isArray(a[0]) ? a[0] : [];
        dash = values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) ? values as number[] : null;
        continue;
      }
      default:
        return null;
    }
    if (!part) return null;
    out.push(part);
  }
  return { d: out.join(" "), dash };
}

const colorOr = (v: unknown, fallback = "transparent"): string => typeof v === "string" && COLOR.test(v) ? v : fallback;

/** A gradient end: a colour at 0/1, or a stop `{color, percentage}` (GPUI: 0..1). */
function stop(end: unknown, at: number): { color: string; offset: number } {
  if (typeof end === "object" && end !== null) {
    const s = end as { color?: unknown; percentage?: unknown };
    const p = typeof s.percentage === "number" && Number.isFinite(s.percentage) ? s.percentage : at;
    return { color: colorOr(s.color), offset: Math.min(1, Math.max(0, p > 1 ? p / 100 : p)) };
  }
  return { color: colorOr(end), offset: at };
}

/** What a path is painted with: an SVG paint value, its opacity, and the `<defs>` entry it refers to. */
function paintOf(paint: Paint, id: string): { paint: string; opacity?: number; def: ReactNode } {
  if (typeof paint === "string") return { paint: colorOr(paint), def: null };
  const bg = (typeof paint === "object" && paint !== null ? paint : {}) as Record<string, unknown>;
  const opacity = typeof bg.opacity === "number" && bg.opacity >= 0 && bg.opacity <= 1 ? bg.opacity : undefined;
  const ref = `url(#${id})`;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);
  switch (bg.kind) {
    case "solid":
      return { paint: colorOr(bg.color), opacity, def: null };
    case "linear_gradient": {
      // CSS angle convention (0° points up, clockwise), in the path's bounding box.
      const rad = ((typeof bg.angle === "number" ? bg.angle : 180) * Math.PI) / 180;
      const [dx, dy] = [Math.sin(rad) / 2, -Math.cos(rad) / 2];
      const [from, to] = [stop(bg.from, 0), stop(bg.to, 1)];
      const def = (
        <linearGradient id={id} x1={0.5 - dx} y1={0.5 - dy} x2={0.5 + dx} y2={0.5 + dy}>
          <stop offset={from.offset} stopColor={from.color} />
          <stop offset={to.offset} stopColor={to.color} />
        </linearGradient>
      );
      return { paint: ref, opacity, def };
    }
    case "pattern_slash": {
      const width = num(bg.width, 1);
      const period = width + num(bg.interval, 4);
      const def = (
        <pattern id={id} width={period} height={period} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={width} height={period} fill={colorOr(bg.color)} />
        </pattern>
      );
      return { paint: ref, opacity, def };
    }
    case "checkerboard": {
      const size = num(bg.size, 8);
      const color = colorOr(bg.color);
      const def = (
        <pattern id={id} width={size * 2} height={size * 2} patternUnits="userSpaceOnUse">
          <rect width={size} height={size} fill={color} />
          <rect x={size} y={size} width={size} height={size} fill={color} />
        </pattern>
      );
      return { paint: ref, opacity, def };
    }
    default:
      return { paint: "transparent", def: null };
  }
}

export function PathView({ node }: { node: PathNode }): ReactElement {
  const { dom, el } = useElement(node, "r-el r-path");
  const style = node.style ?? {};
  const [size, setSize] = useState<{ w: number; h: number } | null>(
    typeof style.width === "number" && typeof style.height === "number" ? { w: style.width, h: style.height } : null,
  );
  // Document-unique and stable across renders (and in server markup): `useId` without its punctuation.
  const id = `herdr-paint-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

  useLayoutEffect(() => {
    const target = el.current;
    if (!target) return;
    const measure = (w: number, h: number) =>
      setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    measure(target.offsetWidth, target.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize?.[0];
      if (box) measure(box.inlineSize, box.blockSize);
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, [el]);

  const spec = node.path;
  const geometry = size && size.w > 0 && size.h > 0 && typeof spec === "object" && spec !== null
    ? pathData(spec.ops, size.w, size.h)
    : null;
  let svg: ReactNode = null;
  if (size && geometry) {
    const { paint, opacity, def } = paintOf(node.paint, id);
    const stroke = spec.kind === "stroke";
    const width = typeof spec.width === "number" && Number.isFinite(spec.width) ? spec.width : 1;
    svg = (
      <svg
        className="r-path__svg"
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        aria-hidden="true"
        focusable="false"
      >
        {def ? <defs>{def}</defs> : null}
        <path
          d={geometry.d}
          fill={stroke ? "none" : paint}
          fillRule="evenodd"
          stroke={stroke ? paint : undefined}
          strokeWidth={stroke ? width : undefined}
          strokeDasharray={stroke && geometry.dash ? geometry.dash.join(" ") : undefined}
          opacity={opacity}
        />
      </svg>
    );
  }
  return <div {...dom}>{svg}</div>;
}
