// `gpui-kit` (and `gpui`): element factories that record instead of drawing. Exports match the runtime values of
// `declare module "gpui-kit"` in fixtures/herdr-home/gpui-kit.d.ts.

import {
  currentCopy,
  element,
  flushLocalStorage,
  host,
  hostObjects,
  lazyList,
  listCx,
  noteUnknown,
  persistLocalStorage,
  ser,
} from "../runtime.js";

export class View {
  constructor(_props) {}
}

export const div = () => element("div");
export const svg = (path) => element("svg", { src: String(path) });
export const image = (path) => element("image", { src: String(path) });

export function list(id, count, getKey, render) {
  return lazyList("list", id, count, {}, getKey, (el, n) => {
    for (let i = 0; i < n; i++) el.child(render(i, listCx()));
  });
}

export function uniform_list(id, count, getKey, render) {
  return lazyList(
    "uniform_list",
    id,
    count,
    {},
    getKey,
    (el, n) => el.children(render({ start: 0, end: n }, listCx())),
  );
}

const PATH_OPS = ["move_to", "line_to", "curve_to", "cubic_bezier_to", "arc_to", "add_polygon", "close", "dash_array"];

/** `PathBuilder`: `build()` returns a `Path` whose tree form is the protocol `PathSpec` `{kind, ops, width?}`. */
function pathBuilder(kind, width) {
  const ops = [];
  const b = {};
  for (const op of PATH_OPS) {
    b[op] = (...args) => {
      ops.push([op, ...args.map((a) => ser(a))]);
      return b;
    };
  }
  b.build = () => {
    const path = {};
    hostObjects.set(path, kind === "stroke" ? { kind, width, ops: [...ops] } : { kind, ops: [...ops] });
    return path;
  };
  return b;
}

export const PathBuilder = {
  fill: () => pathBuilder("fill", null),
  stroke: (width) => pathBuilder("stroke", Number(width)),
};

/** `Background`: the tree form is the protocol `Background` (`{kind, …, opacity?, color_space?}`). */
function background(desc) {
  const bg = {
    opacity: (factor) => background({ ...desc, opacity: Number(factor) }),
    color_space: (space) => background({ ...desc, color_space: String(space) }),
  };
  hostObjects.set(bg, desc);
  return bg;
}

export const Background = {
  solid: (color) => background({ kind: "solid", color: ser(color) }),
  stop: (color, percentage) => {
    const s = {};
    hostObjects.set(s, { color: ser(color), percentage: Number(percentage) });
    return s;
  },
  linear_gradient: (angle, from, to) =>
    background({ kind: "linear_gradient", angle: Number(angle), from: ser(from), to: ser(to) }),
  pattern_slash: (color, width, interval) =>
    background({ kind: "pattern_slash", color: ser(color), width: Number(width), interval: Number(interval) }),
  checkerboard: (color, size) => background({ kind: "checkerboard", color: ser(color), size: Number(size) }),
};

/**
 * `localStorage` / `sessionStorage`: per copy (AGENTS.md: "Each copy still gets its own … localStorage"). Every
 * `localStorage` change sends the copy's whole map to the bridge (`storage.set`, coalesced per macrotask), which
 * persists it; `sessionStorage` lives in this process only.
 */
export function makeStorage(kind) {
  const local = kind === "local";
  const copyOf = () => currentCopy(`${kind}Storage`);
  const map = () => (local ? copyOf().local : copyOf().session);
  const changed = () => {
    if (local) persistLocalStorage(copyOf());
  };
  const storage = {
    get length() {
      return map().size;
    },
    key: (i) => [...map().keys()][i] ?? null,
    getItem: (k) => map().get(String(k)) ?? null,
    setItem: (k, v) => {
      map().set(String(k), String(v));
      changed();
    },
    removeItem: (k) => {
      if (map().delete(String(k))) changed();
    },
    clear: () => {
      if (map().size === 0) return;
      map().clear();
      changed();
    },
  };
  if (local) storage.flush = () => flushLocalStorage(copyOf());
  return storage;
}

/** The ambient `window` global (gpui-kit `Window`), installed by `main.js` before the mod loads. */
export function makeWindowGlobal(local, session) {
  const impl = {
    paint_path: (path, paint) => element("paint_path", { path: ser(path), paint: ser(paint) }),
    is_window_active: () => Boolean(host.state?.window?.active),
    localStorage: local,
    sessionStorage: session,
  };
  return new Proxy(impl, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
      noteUnknown("window", prop);
      return undefined;
    },
  });
}
