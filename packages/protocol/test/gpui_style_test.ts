// The GPUI style parser against the real gpui-kit.d.ts fixtures (read, not copied): every generated no-argument name
// maps to CSS, nothing outside the generated set is accepted, the 59 argument methods map with the d.ts parameter
// types (`p("auto")` refused), and the 103 behavioural methods are all classified.

import { assert, assertEquals } from "@std/assert";
import {
  ARG_STYLE_METHODS,
  BEHAVIOURAL_METHODS,
  mergeStyle,
  parseArgStyle,
  parseStyleCall,
  parseStyleName,
  type Style,
  type StyleArgKind,
  styleMethodKind,
} from "../mod.ts";

const FIXTURE = new URL("../../../fixtures/generic-home/", import.meta.url);

/** Every gpui-kit.d.ts in the fixture (the app home's and the copies Herdr writes into mod folders). */
function findDts(dir: URL, depth = 0): URL[] {
  const out: URL[] = [];
  for (const e of Deno.readDirSync(dir)) {
    if (e.isFile && e.name === "gpui-kit.d.ts") out.push(new URL(e.name, dir));
    else if (e.isDirectory && depth < 3 && e.name !== "node_modules") {
      out.push(...findDts(new URL(`${e.name}/`, dir), depth + 1));
    }
  }
  return out;
}

interface Surface {
  file: string;
  declaredGenerated: number;
  generated: string[];
  /** Argument style method → its d.ts parameter type. */
  arg: Record<string, string>;
  behavioural: string[];
}

function readSurface(url: URL): Surface {
  const lines = Deno.readTextFileSync(url).split("\n");
  const start = lines.findIndex((l) => l.startsWith("  export interface NativeElement {"));
  const argAt = lines.findIndex((l) => l.includes("Style methods that take an argument"));
  const genAt = lines.findIndex((l) => /The \d+ no-argument style methods/.test(l));
  assert(start > 0 && argAt > start && genAt > argAt, `${url.pathname}: NativeElement sections not found`);
  let end = genAt;
  while (lines[end] !== "  }") end++;
  const surface: Surface = {
    file: url.pathname,
    declaredGenerated: Number(/The (\d+) no-argument/.exec(lines[genAt])![1]),
    generated: [],
    arg: {},
    behavioural: [],
  };
  for (let i = start + 1; i < argAt; i++) {
    const m = /^ {4}(\w+)(?:<[^(]*>)?\(/.exec(lines[i]);
    if (m !== null) surface.behavioural.push(m[1]);
  }
  for (let i = argAt; i < genAt; i++) {
    const m = /^ {4}(\w+)<Self extends Element>\(this: Self, value: (\w+)\): Self;$/.exec(lines[i]);
    if (m !== null) surface.arg[m[1]] = m[2];
  }
  for (let i = genAt; i < end; i++) {
    const m = /^ {4}(\w+)<Self extends Element>\(this: Self\): Self;$/.exec(lines[i]);
    if (m !== null) surface.generated.push(m[1]);
  }
  return surface;
}

const surfaces = findDts(FIXTURE).map(readSurface);

Deno.test("the fixture provides gpui-kit.d.ts surfaces", () => {
  assert(surfaces.length >= 1);
  for (const s of surfaces) {
    assertEquals(s.generated.length, s.declaredGenerated, `${s.file}: generated count vs its own comment`);
    assertEquals(new Set(s.generated).size, s.generated.length, `${s.file}: duplicate generated names`);
  }
});

Deno.test("every generated no-argument style name maps to CSS", () => {
  for (const s of surfaces) {
    assertEquals(s.generated.length, 3146, s.file);
    const unparsed = s.generated.filter((n) => {
      const style = parseStyleName(n);
      return style === undefined || Object.keys(style).length === 0 || styleMethodKind(n) !== "generated";
    });
    assertEquals(unparsed, [], `${s.file}: names without a mapping`);
    for (const n of s.generated) assert(parseStyleCall(n, []).ok, n);
  }
});

Deno.test("names outside the generated set are refused (prefix × suffix cross product)", () => {
  for (const s of surfaces) {
    const generated = new Set(s.generated);
    const prefixes = Object.keys(ARG_STYLE_METHODS).filter((p) => s.generated.some((g) => g.startsWith(`${p}_`)));
    const suffixes = new Set<string>();
    for (const g of s.generated) {
      for (const p of prefixes) if (g.startsWith(`${p}_`)) suffixes.add(g.slice(p.length + 1));
    }
    const wrong: string[] = [];
    for (const p of prefixes) {
      for (const suffix of suffixes) {
        const name = `${p}_${suffix}`;
        if ((parseStyleName(name) !== undefined) !== generated.has(name)) wrong.push(name);
      }
    }
    assertEquals(wrong, [], `${s.file}: accepted iff generated`);
  }
  for (
    const n of ["p_auto", "gap_auto", "w_13", "w_neg_auto", "border_13", "border_z_1", "rounded_4xl", "rounded_q_md"]
  ) {
    assertEquals(parseStyleName(n), undefined, n);
  }
});

const KINDS_BY_DTS_TYPE: Record<string, StyleArgKind[]> = {
  Color: ["color"],
  Length: ["length"],
  DefiniteLength: ["definite", "lineHeight"],
  AbsoluteLength: ["absolute"],
  number: ["fontWeight", "unit", "nonNegative"],
  string: ["string"],
};

const GOOD: Record<StyleArgKind, unknown> = {
  length: "auto",
  definite: "50%",
  absolute: "1.5rem",
  lineHeight: 1.45,
  color: "#1e2227",
  fontWeight: 600,
  unit: 0.5,
  nonNegative: 1,
  string: "Geist",
};

const BAD: Record<StyleArgKind, unknown> = {
  length: "50vw",
  definite: "auto",
  absolute: "50%",
  lineHeight: "auto",
  color: "red",
  fontWeight: 50,
  unit: 2,
  nonNegative: -1,
  string: "",
};

Deno.test("the 59 argument style methods map with their d.ts parameter types", () => {
  for (const s of surfaces) {
    assertEquals(Object.keys(s.arg).length, 59, s.file);
    assertEquals(Object.keys(s.arg).sort(), Object.keys(ARG_STYLE_METHODS).sort(), s.file);
    for (const [name, dtsType] of Object.entries(s.arg)) {
      const kind = ARG_STYLE_METHODS[name];
      assert(KINDS_BY_DTS_TYPE[dtsType]?.includes(kind), `${name}: d.ts ${dtsType} vs parser ${kind}`);
      assertEquals(styleMethodKind(name), "arg", name);
      const good = parseArgStyle(name, GOOD[kind]);
      assert(good.ok && Object.keys(good.style).length > 0, `${name}(${JSON.stringify(GOOD[kind])})`);
      assert(!parseArgStyle(name, BAD[kind]).ok, `${name}(${JSON.stringify(BAD[kind])}) should be refused`);
    }
  }
});

Deno.test("argument values follow the d.ts length types", () => {
  const refused = (name: string, value: unknown) => assert(!parseArgStyle(name, value).ok, `${name}(${value})`);
  refused("p", "auto");
  refused("px", "auto");
  refused("gap", "auto");
  refused("rounded", "50%");
  refused("border", "50%");
  refused("text_size", "10%");
  refused("bg", "rebeccapurple");
  refused("bg", "#12345");
  refused("opacity", 1.5);
  refused("font_weight", 1000);
  assertEquals(parseArgStyle("p", "12px"), {
    ok: true,
    style: { paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 },
  });
  assertEquals(parseArgStyle("w", "auto"), { ok: true, style: { width: "auto" } });
  assertEquals(parseArgStyle("w", "50%"), { ok: true, style: { width: "50%" } });
  assertEquals(parseArgStyle("mx", -4), { ok: true, style: { marginLeft: -4, marginRight: -4 } });
  assertEquals(parseArgStyle("line_height", 1.45), { ok: true, style: { lineHeight: 1.45 } });
  assertEquals(parseArgStyle("line_height", "20px"), { ok: true, style: { lineHeight: "20px" } });
  assertEquals(parseArgStyle("text_size", "0.875rem"), { ok: true, style: { fontSize: "0.875rem" } });
  assertEquals(parseArgStyle("bg", "#61afef33"), { ok: true, style: { backgroundColor: "#61afef33" } });
  assertEquals(parseArgStyle("text_bg", "#fff"), { ok: true, style: { "--herdr-text-bg": "#fff" } });
  assert(!parseStyleCall("p", []).ok, "an arg method without its argument");
  assert(!parseStyleCall("w_4", [1]).ok, "a generated method with an argument");
});

Deno.test("the 103 behavioural methods are classified", () => {
  for (const s of surfaces) {
    assertEquals(s.behavioural.length, 103, s.file);
    assertEquals(s.behavioural.slice().sort(), Object.keys(BEHAVIOURAL_METHODS).sort(), s.file);
    for (const n of s.behavioural) assertEquals(styleMethodKind(n), "behaviour", n);
  }
  assertEquals(styleMethodKind("not_a_method"), undefined);
});

Deno.test("generated names map to the documented values", () => {
  const cases: [string, Style][] = [
    ["w_4", { width: 16 }],
    ["w_0p5", { width: 2 }],
    ["w_1_3", { width: "33.3333%" }],
    ["w_neg_1_2", { width: "-50%" }],
    ["h_px", { height: 1 }],
    ["size_full", { width: "100%", height: "100%" }],
    ["max_w_112", { maxWidth: 448 }],
    ["m_auto", { marginTop: "auto", marginRight: "auto", marginBottom: "auto", marginLeft: "auto" }],
    ["my_neg_px", { marginTop: -1, marginBottom: -1 }],
    ["gap_x_2", { columnGap: 8 }],
    ["inset_0", { top: 0, right: 0, bottom: 0, left: 0 }],
    ["top_neg_4", { top: -16 }],
    ["border_x_2", { borderLeftWidth: 2, borderRightWidth: 2 }],
    ["border_dashed", { borderStyle: "dashed" }],
    ["rounded_t_md", { borderTopLeftRadius: 6, borderTopRightRadius: 6 }],
    ["rounded_full", {
      borderTopLeftRadius: 9999,
      borderTopRightRadius: 9999,
      borderBottomRightRadius: 9999,
      borderBottomLeftRadius: 9999,
    }],
    ["h_flex", { display: "flex", flexDirection: "row", alignItems: "center" }],
    ["v_flex", { display: "flex", flexDirection: "column" }],
    ["flex_1", { flexGrow: 1, flexShrink: 1, flexBasis: "0%" }],
    ["items_start", { alignItems: "flex-start" }],
    ["justify_between", { justifyContent: "space-between" }],
    ["self_flex_end", { alignSelf: "flex-end" }],
    ["cursor_not_allowed", { cursor: "not-allowed" }],
    ["text_sm", { fontSize: 14 }],
    ["text_center", { textAlign: "center" }],
    ["text_ellipsis_middle", { textOverflow: "ellipsis", "--herdr-ellipsis": "middle" }],
    ["text_decoration_wavy", { textDecorationStyle: "wavy" }],
    ["font_semibold", { fontWeight: 600 }],
    ["truncate", { overflowX: "hidden", overflowY: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }],
    ["shadow_none", { boxShadow: "none" }],
    ["hidden", { display: "none" }],
    ["invisible", { visibility: "hidden" }],
    ["col_span_full", { gridColumn: "1 / -1" }],
  ];
  for (const [name, style] of cases) assertEquals(parseStyleName(name), style, name);
});

Deno.test("mergeStyle: later calls win; underline and line_through combine", () => {
  const s: Style = {};
  mergeStyle(s, parseStyleName("p_2")!);
  mergeStyle(s, parseStyleName("px_4")!);
  assertEquals(s, { paddingTop: 8, paddingRight: 16, paddingBottom: 8, paddingLeft: 16 });
  mergeStyle(s, parseStyleName("underline")!);
  mergeStyle(s, parseStyleName("line_through")!);
  assertEquals(s.textDecorationLine, "underline line-through");
  mergeStyle(s, parseStyleName("text_decoration_none")!);
  assertEquals(s.textDecorationLine, "none");
});
