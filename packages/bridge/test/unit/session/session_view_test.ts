import { assert, assertEquals } from "@std/assert";
import type { ClickState, CommandInfo, DeviceClass, LayoutNode } from "@herdr-relay/protocol";
import type { SessionWorld } from "../../../src/session/focus.ts";
import { Session } from "../../../src/session/session.ts";

const tree: LayoutNode = JSON.parse(Deno.readTextFileSync("fixtures/layouts/lstack-herdr.json"));
const clicks: ClickState = JSON.parse(Deno.readTextFileSync("fixtures/layouts/.state/lstack-herdr.json"));
const commands: CommandInfo[] = JSON.parse(Deno.readTextFileSync("fixtures/herdr-app-commands.json"));
const ctx = { modFolders: ["lstack-herdr-cockpit"], commands };
const tab = (id: string, index: number, active: boolean) => ({
  id,
  index,
  name: id,
  named: true,
  active,
  status: null,
  panes: 1,
  zoomed: false,
  settled: false,
  settled_at: null,
  changed_at: null,
  working_since: null,
});

function setup(device: DeviceClass) {
  const world: SessionWorld = {
    spaces: [{
      id: "s1",
      index: 1,
      name: "one",
      named: true,
      folder: "/one",
      machine: null,
      branch: null,
      active: true,
      status: null,
      tabs: [tab("t1", 1, true), tab("t2", 2, false)],
    }],
    panes: [
      { pane: "p1", terminal: "term1", tab: "t1", title: "one", focused: true, zoomed: false },
      { pane: "p2", terminal: "term2", tab: "t2", title: "two", focused: false, zoomed: false },
    ],
    agents: [],
    focused: { space: "s1", tab: "t1", pane: "p1", terminal: "term1", shown: null, agent: null, cwd: null },
  };
  const session = new Session({
    id: device,
    scope: "act",
    device,
    layout: { name: "lstack-herdr", tree },
    clicks,
    world: () => world,
  });
  return { session, world };
}

Deno.test("session view tracks device tab selection and zoom without changing the Mac world", () => {
  const { session, world } = setup("desktop");
  const original = structuredClone(world);
  const selected = session.run("tab.select", { id: "t2" }, ctx);
  assert(selected.class === "session" && selected.ok);
  assertEquals(selected.changed.focus, true);
  const view = session.view();
  assert(view);
  assertEquals(view.spaces[0].tabs.map((t) => t.active), [false, true]);
  assertEquals(view.panes.filter((p) => p.focused).map((p) => p.pane), ["p2"]);
  assertEquals(world.spaces[0].tabs[0].active, true);
  assertEquals(world, original);

  const zoomed = session.run("pane.zoom", {}, ctx);
  assert(zoomed.class === "session" && zoomed.ok);
  assertEquals(zoomed.changed.focus, true);
  assertEquals(session.view()?.spaces[0].tabs[1].zoomed, true);
  assertEquals(world, original);
});

Deno.test("invalid tab selection leaves the session view unchanged", () => {
  const { session, world } = setup("desktop");
  const before = structuredClone(session.view());
  const original = structuredClone(world);
  const result = session.run("tab.select", { id: "missing" }, ctx);
  assert(result.class === "session" && !result.ok);
  assertEquals(result.changed.focus, false);
  assertEquals(session.view(), before);
  assertEquals(world, original);
});

Deno.test("phone session view never exposes zoom", () => {
  const { session, world } = setup("phone");
  world.spaces[0].tabs[0].zoomed = true;
  world.panes[0].zoomed = true;
  const selected = session.run("tab.select", { id: "t2" }, ctx);
  assert(selected.class === "session" && selected.ok);
  const zoomed = session.run("pane.zoom", {}, ctx);
  assert(zoomed.class === "session" && zoomed.ok);
  const view = session.view();
  assert(view);
  assertEquals(view.spaces.flatMap((s) => s.tabs.map((t) => t.zoomed)), [false, false]);
  assertEquals(view.panes.map((p) => p.zoomed), [false, false]);
});
