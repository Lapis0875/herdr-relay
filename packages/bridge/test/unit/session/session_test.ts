import { assert, assertEquals } from "@std/assert";
import type { ClickState, CommandInfo, LayoutNode } from "@herdr-relay/protocol";
import { classifyCommand } from "../../../src/session/commands.ts";
import { Session } from "../../../src/session/session.ts";
import type { SessionWorld } from "../../../src/session/focus.ts";

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
const world: SessionWorld = {
  spaces: [
    {
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
    },
    {
      id: "s2",
      index: 2,
      name: "two",
      named: true,
      folder: "/two",
      machine: null,
      branch: null,
      active: false,
      status: null,
      tabs: [tab("t3", 1, true)],
    },
  ],
  panes: [
    { pane: "p1", terminal: "term1", tab: "t1", title: "one", focused: true, zoomed: false },
    { pane: "p2", terminal: "term2", tab: "t2", title: "two", focused: false, zoomed: false },
    { pane: "p3", terminal: "term3", tab: "t3", title: "three", focused: false, zoomed: false },
  ],
  agents: [{
    address: "term2",
    pane: "p2",
    space: "s1",
    space_name: "one",
    tab: "t2",
    tab_index: 2,
    tab_name: "t2",
    status: "idle",
    app: null,
    program: {
      key: "agent",
      name: "Agent",
      icon: null,
      tint: false,
      tile: null,
      color: null,
      shell: false,
      agent: true,
    },
    title: "Agent",
    seq: 1,
    pinned: false,
    focused: false,
  }],
  focused: { space: "s1", tab: "t1", pane: "p1", terminal: "term1", shown: null, agent: null, cwd: null },
};
const makeSession = (scope: "act" | "read" = "act") =>
  new Session({
    id: scope,
    scope,
    device: "phone",
    layout: { name: "lstack-herdr", tree },
    clicks,
    world: () => world,
  });

Deno.test("all 71 captured commands are classified into amended classes", () => {
  assertEquals(commands.length, 71);
  assertEquals(new Set(commands.map((c) => c.name)).size, 71);
  const counts: Record<string, number> = {};
  for (const { name } of commands) {
    const classification = classifyCommand(name);
    assert(classification.class !== "unknown", `unclassified: ${name}`);
    counts[classification.class] = (counts[classification.class] ?? 0) + 1;
  }
  assertEquals(counts, { session: 20, passthrough: 7, structural: 44 });
  assertEquals(classifyCommand("unknown.command").class, "unknown");
  assertEquals(classifyCommand("window.unlisted").class, "structural");
  assertEquals(classifyCommand("lstack-herdr-cockpit.show:inbox", ctx.modFolders).class, "mod");
});

Deno.test("layout show, hide and toggle update only the originating navigator", () => {
  const s = makeSession();
  const other = makeSession();
  assertEquals(s.graph.stack, ["/", "/panel"]);
  for (
    const [name, expectedNav, stack] of [
      ["layout.hide", [{ action: "pop", route: "/panel" }], ["/"]],
      ["layout.show", [{ action: "push", route: "/panel" }], ["/", "/panel"]],
      ["layout.toggle", [{ action: "pop", route: "/panel" }], ["/"]],
      ["layout.toggle", [{ action: "push", route: "/panel" }], ["/", "/panel"]],
    ] as const
  ) {
    const result = s.run(name, { id: "panel" }, ctx);
    assert(result.class === "session" && result.ok, name);
    assertEquals(result.nav, [...expectedNav]);
    assertEquals(s.graph.stack, [...stack]);
    assertEquals(other.graph.stack, ["/", "/panel"]);
  }
  const before = s.graph;
  const bad = s.run("layout.show", { id: "missing" }, ctx);
  assert(bad.class === "session" && !bad.ok);
  assertEquals(s.graph, before);
});

Deno.test("layout.select switches current stack or replaces a different route", () => {
  const s = makeSession();
  const onPanel = s.run("layout.select", { stack: "panel-body", child: "files" }, ctx);
  assert(onPanel.class === "session" && onPanel.ok);
  assertEquals(onPanel.nav, []);
  const onHome = s.run("layout.select", { stack: "center", child: "inbox" }, ctx);
  assert(onHome.class === "session" && onHome.ok);
  assertEquals(onHome.nav, [{ action: "replace", route: "/" }]);
  const before = s.graph;
  const bad = s.run("layout.select", { stack: "center", child: "not-a-child" }, ctx);
  assert(bad.class === "session" && !bad.ok);
  assertEquals(s.graph, before);
});

Deno.test("focus commands are local and passthrough uses device focus", () => {
  const s = makeSession();
  const other = makeSession();
  for (
    const [name, args, key, value] of [
      ["space.select", { id: "s2" }, "space", "s2"],
      ["tab.select", { id: "t2" }, "tab", "t2"],
      ["pane.focus", { pane: "p1" }, "pane", "p1"],
      ["agent.focus", { terminal: "term2" }, "agent", "term2"],
    ] as const
  ) {
    const result = s.run(name, args, ctx);
    assert(result.class === "session" && result.ok, name);
    assertEquals(s.focused()?.[key], value);
  }
  assertEquals(other.focused()?.terminal, "term1");
  assertEquals(s.run("terminal.scroll", {}, ctx), {
    class: "passthrough",
    name: "terminal.scroll",
    args: { terminal: "term2" },
  });
  const before = s.focused();
  const invalid = s.run("space.select", { id: "missing" }, ctx);
  assert(invalid.class === "session" && !invalid.ok);
  assertEquals(s.focused(), before);
  assert(s.intercept("pane.zoom", {}).ok);
  assertEquals(s.zoomed(), null);
});

Deno.test("D3 refuses structural operations and unknown commands", () => {
  const s = makeSession();
  for (
    const name of [
      "tab.new",
      "tab.close",
      "tab.settle",
      "tab.move",
      "pane.split",
      "pane.close",
      "pane.swap",
      "space.new",
      "space.close",
      "space.rename",
      "layout.save",
      "layout.delete",
    ]
  ) {
    const result = s.run(name, {}, ctx);
    assert(result.class === "refused", name);
    assertEquals(result.error, "structural");
    assertEquals(result.message, "Structural change — use the Herdr window");
  }
  assertEquals(s.run("no.such.command", {}, ctx).class, "refused");
});

Deno.test("read scope permits device-local navigation but refuses remote effects", () => {
  const s = makeSession("read");
  const local = s.run("layout.hide", { id: "panel" }, ctx);
  assert(local.class === "session" && local.ok);
  assertEquals(s.graph.stack, ["/"]);
  const focus = s.run("pane.focus", { pane: "p2" }, ctx);
  assert(focus.class === "session" && focus.ok);
  assertEquals(s.focused()?.pane, "p2");
  const before = s.graph;
  for (const name of ["terminal.scroll", "lstack-herdr-cockpit.show:inbox"]) {
    const result = s.run(name, {}, ctx);
    assert(result.class === "refused", name);
    assertEquals(result.error, "read-only-device");
    assertEquals(s.graph, before);
  }
  const structural = s.run("pane.split", {}, ctx);
  assert(structural.class === "refused");
  assertEquals(structural.error, "structural");
});
