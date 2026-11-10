// RecordedTree → ElementTree conversion.

import { assert, assertEquals } from "@std/assert";
import {
  type ElementNode,
  ElementTreeSchema,
  errorNode,
  type RecordedElement,
  type RecordedTree,
  toElementTree,
  validate,
} from "../mod.ts";

const SAMPLES = new URL("../samples/shapes/", import.meta.url);
const readJson = (name: string): unknown => JSON.parse(Deno.readTextFileSync(new URL(name, SAMPLES)));

const el = (tag: string, extra: Partial<RecordedElement> = {}): RecordedElement => ({
  tag,
  style: [],
  handlers: [],
  children: [],
  ...extra,
});

function convert(rec: RecordedTree) {
  const out = toElementTree(rec);
  const v = validate(ElementTreeSchema, out.tree);
  assert(v.ok, `converted tree does not validate: ${JSON.stringify(v.ok ? [] : v.errors)}`);
  return out;
}

Deno.test("the RecordedTree sample converts to the ElementTree sample without diagnostics", () => {
  const { tree, diagnostics } = convert(readJson("RecordedTree.json") as RecordedTree);
  assertEquals(diagnostics, []);
  assertEquals(tree, readJson("ElementTree.json") as ElementNode);
});

Deno.test("text and entity roots", () => {
  assertEquals(convert({ text: "hi" }).tree, { k: "text", style: {}, text: "hi" });
  assertEquals(convert({ entity: "e7" }).tree, { k: "view", style: {}, view: "e7" });
});

Deno.test("a border width without a style gets borderStyle solid, also inside states", () => {
  const { tree } = convert(el("div", { style: [["border_1"]], states: { hover: [["border_b", 2]] } }));
  assertEquals(tree.style, {
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderLeftWidth: 1,
    borderStyle: "solid",
  });
  assertEquals(tree.states?.hover, { borderBottomWidth: 2, borderStyle: "solid" });
  assertEquals(convert(el("div", { style: [["border_dashed"], ["border_2"]] })).tree.style.borderStyle, "dashed");
});

Deno.test("handlers map to on, with mouse buttons and actions", () => {
  const { tree, diagnostics } = convert(el("div", {
    handlers: [
      { event: "on_click", id: 1 },
      { event: "on_mouse_down", id: 2, args: ["left"] },
      { event: "on_mouse_down", id: 3, args: ["right"] },
      { event: "on_mouse_up", id: 4, args: ["middle"] },
      { event: "on_action", id: 5, args: ["save"] },
      { event: "on_item_click", id: 6 },
      { event: "on_size_change", id: 7 },
      { event: "on_key_up", id: 8 },
    ],
  }));
  assertEquals(diagnostics, []);
  assertEquals(tree.on, {
    click: 1,
    mousedown: { left: 2, right: 3 },
    mouseup: { middle: 4 },
    action: { save: 5 },
    item: 6,
    size: 7,
    keyup: 8,
  });
});

Deno.test("motion: spin, frames, loop default period, transition by number, spring", () => {
  const { tree, diagnostics } = convert(el("div", {
    style: [
      ["spin", 900],
      ["frames", ["⠋", "⠙", "⠹"], 80],
      ["loop", "opacity", { from: 0.4, to: 1 }],
      ["transition", "width", 300],
      ["transition", "width", { duration: 400, easing: "ease-out" }],
      ["spring", "left"],
    ],
  }));
  assertEquals(diagnostics, []);
  assertEquals(tree.anim, {
    spin: 900,
    frames: [["⠋", "⠙", "⠹"], 80],
    loop: { prop: "opacity", from: 0.4, to: 1, period: 1000 },
    transition: [["width", { duration: 400, easing: "ease-out" }]],
    spring: [["left", {}]],
  });
});

Deno.test("attributes and scrolling", () => {
  const { tree } = convert(el("div", {
    style: [
      ["tooltip", "Copy"],
      ["disabled", true],
      ["set_position", 2, 5],
      ["aria_active_descendant"],
      ["overflow_x_scrollbar"],
    ],
  }));
  assertEquals(tree.attrs, {
    tooltip: "Copy",
    disabled: true,
    set_position: [2, 5],
    aria_active_descendant: true,
    scrollbar: "x",
  });
  assertEquals(tree.style, { overflowX: "auto" });
});

Deno.test("widgets: TextView, Scrollbar, virtual list, HoverCard slots", () => {
  const md = convert(el("TextView", { id: "notes", props: { format: "markdown", source: "**hi**" } })).tree;
  assertEquals(md.widget, { type: "markdown", state: "notes", props: { source: "**hi**" } });
  const bar = convert(el("Scrollbar", { props: { axis: "vertical", state: "rows" } })).tree;
  assertEquals(bar.widget, { type: "scrollbar", state: "rows", props: { axis: "vertical" } });
  const list = convert(el("v_virtual_list", { id: "rows", props: { args: ["rows", 120] } })).tree;
  assertEquals(list.widget, { type: "vlist", state: "rows", props: { args: ["rows", 120] } });
  const card = convert(el("HoverCard", {
    id: "card",
    slots: { trigger: el("div", { children: [{ text: "?" }] }), content: el("v_flex") },
  })).tree;
  assertEquals(card.widget?.type, "hovercard");
  assertEquals(card.slots?.trigger.children, [{ k: "text", style: {}, text: "?" }]);
  assertEquals(card.slots?.content.style, { display: "flex", flexDirection: "column" });
});

Deno.test("everything that cannot convert is reported with its path", () => {
  const { tree, diagnostics } = convert(el("div", {
    style: [["p", "auto"], ["no_such_method"], ["on_click"], ["spin", 50]],
    // "pressed" is not a refinement: a host could send it, so the converter must report it.
    states: { hover: [["tooltip", "x"]], pressed: [["bg", "#fff"]] } as RecordedElement["states"],
    handlers: [{ event: "on_mouse_down", id: 1, args: ["back"] }, { event: "on_tap", id: 2 }],
    slots: { sidebar: el("div") },
    children: [el("svg"), el("TextView", { props: { format: "rtf" } })],
  }));
  assertEquals(diagnostics.map((d) => [d.path, d.method]), [
    ["/style/0", "p"],
    ["/style/1", "no_such_method"],
    ["/style/2", "on_click"],
    ["/style/3", "spin"],
    ["/states/hover/0", "tooltip"],
    ["/states/pressed", "pressed"],
    ["/handlers/0", "on_mouse_down"],
    ["/handlers/1", "on_tap"],
    ["/slots/sidebar", "sidebar"],
    ["/children/0", "svg"],
    ["/children/1", "TextView"],
  ]);
  assertEquals(tree.style, {});
  assertEquals(tree.children?.map((c) => c.k), ["error", "error"]);
});

Deno.test("Object.prototype names are unknown methods, tags and slots", () => {
  // JSON.parse makes "__proto__" an own key, as a host line would.
  const rec = JSON.parse(
    '{"tag":"constructor","style":[["constructor"],["toString"]],"handlers":[],"children":[],' +
      '"slots":{"__proto__":{"tag":"div","style":[],"handlers":[],"children":[]}}}',
  ) as RecordedElement;
  const { tree, diagnostics } = convert(rec);
  assertEquals(tree, { k: "el", tag: "constructor", style: {} });
  assertEquals(diagnostics.map((d) => [d.path, d.message]), [
    ["/style/0", "not a gpui-kit element method"],
    ["/style/1", "not a gpui-kit element method"],
    ["/slots/__proto__", "not a gpui-kit slot"],
  ]);
});

Deno.test("errorNode", () => {
  assertEquals(errorNode("host failed", "changes"), {
    k: "error",
    style: {},
    reason: "host failed",
    folder: "changes",
  });
  assertEquals(errorNode("refused"), { k: "error", style: {}, reason: "refused" });
});
