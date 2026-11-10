import { assert, assertEquals, assertExists } from "@std/assert";
import { applyClicks, type ClickState, type DeviceClass, type LayoutNode, recompose, screenNodes } from "../../mod.ts";

const tree: LayoutNode = JSON.parse(Deno.readTextFileSync("fixtures/layouts/lstack-herdr.json"));
const saved: ClickState = JSON.parse(Deno.readTextFileSync("fixtures/layouts/.state/lstack-herdr.json"));
// The design's example specifies files; the captured state currently selects tree.
const example: ClickState = { ...saved, nodes: { ...saved.nodes, "panel-body": { active: "files" } } };
const layout = { name: "lstack-herdr", tree };
const graph = (device: DeviceClass) => recompose(layout, example, device);

for (const device of ["phone", "tablet-portrait", "tablet-landscape", "desktop"] as const) {
  Deno.test(`lstack ${device}: golden composition`, () => {
    const g = graph(device);
    assertEquals(g.class, device);
    assertEquals(g.layout, "lstack-herdr");
    const nodes = g.routes.flatMap((r) => [...screenNodes(r.screen)]);
    const center = nodes.find((n) => n.id === "center" && n.kind === "group");
    assert(center?.kind === "group");
    assertEquals(center.active, "work");
    assertEquals(center.destinations.map((d) => d.id), [
      "home",
      "work",
      "inbox",
      "runbook",
      "todo",
      "meetings",
      "monitor",
      "routines",
      "mail",
    ]);
    assertEquals(center.nav, device === "phone" ? "segments" : "tabs");
    assertEquals(
      center.shown,
      device === "phone" ? ["home", "work", "inbox", "runbook"] : center.destinations.map((d) => d.id),
    );
    assertEquals(center.more, device === "phone" ? ["todo", "meetings", "monitor", "routines", "mail"] : []);
    const panes = nodes.find((n) => n.id === "main" && n.kind === "panes");
    assert(panes?.kind === "panes");
    assertEquals(panes.mode, device === "phone" ? "pager" : "split");
    assertEquals(panes.header, { folder: "lstack-herdr-cockpit", props: { app: "pane" }, height: 30, position: "top" });
    assert(nodes.some((n) => n.kind === "terminal" && n.agent === "focused"));
    assert(nodes.some((n) => n.kind === "bar" && n.id === "topbar" && n.px === 42));
    assert(nodes.some((n) => n.kind === "bar" && n.id === "status" && n.px === 34));
    assertEquals(g.sheets.map(({ id, edge, peek }) => ({ id, edge, peek })), [{
      id: "queue",
      edge: device === "phone" ? "bottom" : "right",
      peek: 44,
    }]);
    const panel = nodes.find((n) => n.kind === "group" && n.id === "panel-body");
    assert(panel?.kind === "group");
    assertEquals(panel.active, "files");
    assertEquals(panel.destinations.map((d) => d.id), ["show", "review", "runbook-panel", "files", "changes", "tree"]);
    if (device === "phone") {
      assertEquals(g.routes.find((r) => r.path === "/")?.node, "main-area");
      assertEquals(g.routes.find((r) => r.path === "/drawer")?.node, "sidebar");
      assertEquals(g.routes.find((r) => r.path === "/panel")?.open, "push");
      assertExists(g.routes.find((r) => r.path === "/home-agent"));
      assertEquals(g.stack, ["/", "/panel"]);
    } else if (device === "tablet-portrait") {
      assertEquals(g.routes.find((r) => r.path === "/panel")?.open, "sheet");
      const sidebar = nodes.find((n) => n.id === "sidebar" && n.kind === "split");
      assert(sidebar?.kind === "split");
      assertEquals(sidebar.size?.px, 44);
      assertEquals(sidebar.collapsed, true);
    } else {
      const panelNode = nodes.find((n) => n.id === "panel" && n.kind === "split");
      assert(panelNode?.kind === "split");
      assertEquals(panelNode.size?.px, 280); // Saved 24 clamped to min, not an R1 bar.
      assertEquals(g.stack, ["/"]);
    }
  });
}

Deno.test("unknown saved node ids cannot alter layout or screen graph", () => {
  const poisoned: ClickState = {
    ...example,
    nodes: { ...example.nodes, "not-in-layout": { hidden: false, active: "work", size: { px: 1 } } },
  };
  assertEquals(applyClicks(tree, poisoned), applyClicks(tree, example));
  for (const device of ["phone", "tablet-portrait", "tablet-landscape", "desktop"] as const) {
    assertEquals(recompose(layout, poisoned, device), recompose(layout, example, device));
  }
});

Deno.test("bar threshold and resize bounds are structural, not ids", () => {
  const t: LayoutNode = {
    id: "root",
    type: "row",
    children: [
      { id: "small", type: "block", size: { px: 72 }, content: { mod: "x" } },
      { id: "bounded", type: "block", size: { px: 24 }, min: 80, max: 200, content: { mod: "x" } },
      { id: "main", type: "block", content: { mod: "x" } },
      { id: "large", type: "block", size: { px: 73 }, content: { mod: "x" } },
    ],
  };
  const g = recompose({ name: "boundary", tree: t }, null, "desktop");
  const nodes = [...screenNodes(g.routes[0].screen)];
  assert(nodes.some((n) => n.id === "small" && n.kind === "bar" && n.px === 72));
  assert(nodes.some((n) => n.id === "bounded" && n.kind === "block" && n.size?.px === 80));
  assert(!nodes.some((n) => n.id === "large" && n.kind === "bar"));
});

Deno.test("hidden stack destinations remain listed but unmounted", () => {
  const t: LayoutNode = {
    id: "choices",
    type: "stack",
    active: "one",
    children: [
      { id: "one", type: "block", content: { mod: "x" } },
      { id: "two", type: "block", hidden: true, content: { mod: "x" } },
    ],
  };
  const g = recompose({ name: "hidden", tree: t }, null, "phone");
  const group = g.routes[0].screen;
  assert(group.kind === "group");
  assertEquals(group.destinations.map(({ id, mounted }) => ({ id, mounted })), [{ id: "one", mounted: true }, {
    id: "two",
    mounted: false,
  }]);
});
