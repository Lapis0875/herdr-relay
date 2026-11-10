import { assert, assertEquals, assertExists } from "@std/assert";
import {
  applyClicks,
  applyProfile,
  type ClickState,
  type DeviceClass,
  type LayoutNode,
  type LayoutProfileSection,
  overridable,
  recomposeTree,
  screenNodes,
} from "../../mod.ts";

const read = (path: string) => JSON.parse(Deno.readTextFileSync(path));
const main: LayoutNode = read("fixtures/generic-home/layouts/main.json");
const terminals: LayoutNode = read("fixtures/generic-home/layouts/terminals.json");
const win98: LayoutNode = read("fixtures/generic-home/layouts/win98.json");
const lstack: LayoutNode = read("fixtures/layouts/lstack-herdr.json");
const saved: ClickState = read("fixtures/layouts/.state/lstack-herdr.json");
const fixtures = [
  { name: "main", tree: main, bar: "brand", fixed: "sidebar-lists" },
  { name: "terminals", tree: terminals, bar: "tabs", fixed: "main" },
  { name: "win98", tree: win98, bar: "taskbar", fixed: "desktop" },
  { name: "lstack", tree: lstack, bar: "topbar", fixed: "cockpit-sidebar" },
  { name: "lstack-state", tree: applyClicks(lstack, saved), bar: "topbar", fixed: "cockpit-sidebar" },
];
const devices: DeviceClass[] = ["phone", "tablet-portrait", "tablet-landscape", "desktop"];

function find(tree: LayoutNode, id: string): LayoutNode | undefined {
  if (tree.id === id) return tree;
  for (const child of tree.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
}

function expectedIds(name: string, device: DeviceClass): string[] {
  if (device === "phone" || name === "terminals" || name === "win98") return [];
  if (name === "main") {
    return device === "tablet-portrait" ? ["agents", "sidebar", "spaces"] : ["agents", "panel", "sidebar", "spaces"];
  }
  return device === "tablet-portrait" ? ["sidebar"] : ["home-agent", "panel", "sidebar"];
}

for (const fixture of fixtures) {
  for (const device of devices) {
    Deno.test(`profile ${fixture.name} ${device}: eligibility and scenario matrix`, async (t) => {
      const base = fixture.tree;
      const before = structuredClone(base);
      const baseline = recomposeTree(fixture.name, base, device);
      const ids = expectedIds(fixture.name, device);
      assertEquals([...overridable(base, device).keys()].sort(), ids);
      const scenarios: { name: string; section: LayoutProfileSection; applied: string[] }[] = [
        { name: "none", section: {}, applied: [] },
        { name: "sidebar px", section: { sidebar: { px: 320 } }, applied: ids.includes("sidebar") ? ["sidebar"] : [] },
        {
          name: "collapsed",
          section: { sidebar: { collapsed: true } },
          applied: ids.includes("sidebar") ? ["sidebar"] : [],
        },
        { name: "out of bounds", section: { panel: { px: 10 } }, applied: ids.includes("panel") ? ["panel"] : [] },
        {
          name: "weight pair",
          section: { spaces: { weight: 0.6 }, agents: { weight: 1.4 } },
          applied: ids.includes("spaces") ? ["agents", "spaces"] : [],
        },
        { name: "unknown id", section: { "missing-node": { px: 320 } }, applied: [] },
        { name: "bar id", section: { [fixture.bar]: { px: 320 } }, applied: [] },
        {
          name: "non-resizable parent child",
          section: { [fixture.fixed]: { px: 320, weight: 2, collapsed: true } },
          applied: [],
        },
        { name: "px on weight node", section: { spaces: { px: 320 } }, applied: [] },
      ];
      for (const { name, section, applied } of scenarios) {
        await t.step(name, () => {
          const effective = applyProfile(base, section, device);
          const expected = structuredClone(base);
          for (const id of applied) {
            const node = find(expected, id);
            assertExists(node);
            if (name === "sidebar px") node.size = { ...node.size, px: 320 };
            if (name === "collapsed") node.collapsed = true;
            if (name === "out of bounds") node.size = { ...node.size, px: 280 };
            if (name === "weight pair") node.size = { ...node.size, weight: id === "spaces" ? 0.6 : 1.4 };
          }
          assertEquals(effective, expected);
          assertEquals(base, before, "applying a profile must not mutate the source");
          const graph = recomposeTree(fixture.name, effective, device);
          if (applied.length === 0) assertEquals(graph, baseline);
          if (name === "out of bounds" && applied.length) {
            const panel = graph.routes.flatMap((r) => [...screenNodes(r.screen)]).find((n) => n.id === "panel");
            if (panel && "size" in panel) assertEquals(panel.size?.px, 280);
          }
        });
      }
    });
  }
}

for (const fixture of fixtures.filter((f) => f.name === "main" || f.name.startsWith("lstack"))) {
  Deno.test(`profile ${fixture.name}: portrait sidebar defaults collapsed and can expand`, () => {
    const sidebar = (section: LayoutProfileSection) => {
      const graph = recomposeTree(
        fixture.name,
        applyProfile(fixture.tree, section, "tablet-portrait"),
        "tablet-portrait",
      );
      const node = graph.routes.flatMap((r) => [...screenNodes(r.screen)]).find((n) => n.id === "sidebar");
      assert(node?.kind === "split");
      return node;
    };
    assertEquals(sidebar({}).collapsed, true);
    assertEquals(sidebar({}).size?.px, 44);
    assert(!sidebar({ sidebar: { collapsed: false } }).collapsed);
    assertEquals(sidebar({ sidebar: { collapsed: false } }).size?.px, fixture.name === "lstack-state" ? 320 : 268);
    assertEquals(sidebar({ sidebar: { px: 320, collapsed: false } }).size?.px, 320);
  });
}
