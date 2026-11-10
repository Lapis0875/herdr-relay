import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join, resolve } from "@std/path";
import { type ClickState, type DeviceClass, type LayoutNode, screenNodes } from "@herdr-relay/protocol";
import { LAYOUT_PROFILE_MAX_BYTES, LayoutProfileStore, ProfileRefusal } from "../../../src/session/profiles.ts";
import { Session } from "../../../src/session/session.ts";
import { prepareLink } from "../../security/git_link.ts";

const tree: LayoutNode = JSON.parse(Deno.readTextFileSync("fixtures/layouts/lstack-herdr.json"));
const clicks: ClickState = JSON.parse(Deno.readTextFileSync("fixtures/layouts/.state/lstack-herdr.json"));
const sidebar = (session: Session) => {
  const root = session.layout.tree;
  assert("children" in root && root.children);
  const node = root.children.find((child) => child.id === "sidebar");
  assert(node);
  return node.size;
};

Deno.test("profile files use private modes, atomic replacement, and disappear when emptied", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp" });
  const store = await LayoutProfileStore.open(dir, () => {});
  try {
    const profile = store.device("device-a");
    profile.put("main", "desktop", { sidebar: { px: 320 } });
    await store.flush();
    const path = store.pathOf("device-a")!;
    const old = await Deno.open(path, { read: true });
    try {
      profile.put("main", "desktop", { sidebar: { px: 400 } });
      await store.flush();
      const previous = await new Response(old.readable).text();
      assertEquals(JSON.parse(previous).layouts.main.desktop.sidebar.px, 320);
      assertEquals(JSON.parse(await Deno.readTextFile(path)).layouts.main.desktop.sidebar.px, 400);
    } finally {
      try {
        old.close();
      } catch { /* Response consumes the handle. */ }
    }
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(store.dir!)).mode! & 0o777, 0o700);
      assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    }
    profile.put("main", "desktop", {});
    await store.flush();
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
  } finally {
    await store.flush();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("profile cap evicts least recently changed whole layouts and refuses an oversized current layout atomically", () => {
  const store = LayoutProfileStore.memory();
  const profile = store.device("one");
  const entry = (n: number) => ({ ["n".repeat(n)]: { px: 1 } });
  profile.put("old", "desktop", entry(22000));
  profile.put("recent", "desktop", entry(22000));
  profile.put("old", "tablet-landscape", { x: { px: 2 } });
  profile.put("new", "desktop", entry(22000));
  assertEquals(profile.section("recent", "desktop"), {});
  assertEquals(profile.section("old", "desktop"), entry(22000));
  assertEquals(profile.section("old", "tablet-landscape"), { x: { px: 2 } });
  assertEquals(profile.section("new", "desktop"), entry(22000));
  assert(store.bytes("one") <= LAYOUT_PROFILE_MAX_BYTES);
  assertThrows(() => profile.put("new", "desktop", entry(LAYOUT_PROFILE_MAX_BYTES)), ProfileRefusal);
  assertEquals(profile.section("new", "desktop"), entry(22000));
  assertEquals(profile.section("old", "desktop"), entry(22000));
});

Deno.test("malformed and oversized profiles load empty with one log per file", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp" });
  try {
    const profiles = join(dir, "layout-profiles");
    await Deno.mkdir(profiles);
    await Deno.writeTextFile(join(profiles, "broken.json"), "not json");
    await Deno.writeTextFile(join(profiles, "large.json"), "x".repeat(LAYOUT_PROFILE_MAX_BYTES + 1));
    const logs: string[] = [];
    const store = await LayoutProfileStore.open(dir, (line) => logs.push(line));
    assertEquals(store.section("broken", "main", "desktop"), {});
    assertEquals(store.section("large", "main", "desktop"), {});
    assertEquals(logs.length, 2);
    assertEquals(logs.filter((s) => s.includes("broken")).length, 1);
    assertEquals(logs.filter((s) => s.includes("large")).length, 1);
    await store.flush();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "unreadable profile loads empty and logs once",
  ignore: Deno.build.os === "windows",
  async fn() {
    await Deno.mkdir(".tmp", { recursive: true });
    const dir = await Deno.makeTempDir({ dir: ".tmp" });
    const profiles = join(dir, "layout-profiles");
    const path = join(profiles, "private.json");
    try {
      await Deno.mkdir(profiles);
      await Deno.writeTextFile(
        path,
        JSON.stringify({ v: 1, layouts: { main: { desktop: { sidebar: { px: 300 } } } } }),
      );
      await Deno.chmod(path, 0);
      const logs: string[] = [];
      const store = await LayoutProfileStore.open(dir, (line) => logs.push(line));
      assertEquals(store.section("private", "main", "desktop"), {});
      assertEquals(logs.length, 1);
      assert(logs[0].includes("cannot read"));
      await store.flush();
    } finally {
      await Deno.chmod(path, 0o600);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("unsafe IDs stay memory-only and retaining paired devices deletes only unpaired profiles", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp" });
  const store = await LayoutProfileStore.open(dir, () => {});
  try {
    for (const id of ["local", "paired", "revoked", "../escape"]) {
      store.device(id).put("main", "desktop", { sidebar: { px: 300 } });
    }
    await store.flush();
    assertEquals(store.pathOf("../escape"), null);
    assertEquals(store.section("../escape", "main", "desktop"), { sidebar: { px: 300 } });
    store.retain((id) => id === "local" || id === "paired");
    await store.flush();
    assertEquals(store.devices.sort(), ["local", "paired"]);
    await assertRejects(() => Deno.stat(join(store.dir!, "revoked.json")), Deno.errors.NotFound);
    assert((await Deno.stat(join(store.dir!, "local.json"))).isFile);
  } finally {
    await store.flush();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("session applies file, state, profile and transient clicks in order and clamps on apply", () => {
  const store = LayoutProfileStore.memory();
  const profile = store.device("tablet");
  const make = () =>
    new Session({
      id: "s",
      scope: "act",
      device: "tablet-landscape",
      layout: { name: "lstack-herdr", tree },
      clicks,
      profile,
    });
  const fileOnly = new Session({
    id: "file",
    scope: "act",
    device: "tablet-landscape",
    layout: { name: "lstack-herdr", tree },
    clicks: null,
    profile,
  });
  assertEquals(sidebar(fileOnly), { px: 268 });
  const base = make();
  assertEquals(sidebar(base), { px: 320 });
  profile.put("lstack-herdr", "tablet-landscape", { sidebar: { px: 900 } });
  const s = make();
  assertEquals(sidebar(s), { px: 480 });
  assertEquals(profile.section("lstack-herdr", "tablet-landscape").sidebar.px, 900);
  const result = s.run("layout.resize", { id: "sidebar", px: 350 }, { modFolders: [] });
  assert(result.class === "session" && result.ok);
  assertEquals(sidebar(s), { px: 350 });
  // A wrong-kind transient resize changes the slot kind, so the saved px is ignored but retained.
  s.run("layout.resize", { id: "sidebar", weight: 2 }, { modFolders: [] });
  assertEquals(sidebar(s), { weight: 2 });
  assertEquals(profile.section("lstack-herdr", "tablet-landscape").sidebar.px, 350);
});

Deno.test("overridden reports only applied eligible entries and reset removes them", () => {
  const store = LayoutProfileStore.memory();
  const profile = store.device("tablet");
  profile.put("lstack-herdr", "desktop", {
    sidebar: { px: 360 },
    missing: { px: 1 },
    brand: { px: 60 },
    "cockpit-sidebar": { weight: 2 },
    panel: { weight: 3 },
  });
  const s = new Session({
    id: "s",
    scope: "read",
    device: "desktop",
    layout: { name: "lstack-herdr", tree },
    clicks,
    profile,
  });
  assertEquals(s.graph.overridden, ["sidebar"]);
  assert(s.layoutProfile({ t: "layout", id: 1, action: "reset", node: "sidebar" }).ok);
  assertEquals(s.graph.overridden ?? [], []);
  assert(s.layoutProfile({ t: "layout", id: 2, action: "reset" }).ok);
  assertEquals(profile.section("lstack-herdr", "desktop"), {});
});

Deno.test("rotation and layout switches restore the corresponding layout and class sections", () => {
  const profile = LayoutProfileStore.memory().device("tablet");
  profile.put("lstack-herdr", "tablet-landscape", { sidebar: { px: 360 } });
  profile.put("lstack-herdr", "tablet-portrait", { sidebar: { px: 300, collapsed: false } });
  const s = new Session({
    id: "s",
    scope: "read",
    device: "tablet-landscape",
    layout: { name: "lstack-herdr", tree },
    clicks,
    profile,
  });
  assertEquals(sidebar(s), { px: 360 });
  s.setDevice("tablet-portrait");
  assertEquals(sidebar(s), { px: 300 });
  s.setLayout({ name: "terminals", tree }, null);
  assertEquals(s.graph.overridden ?? [], []);
  s.setLayout({ name: "lstack-herdr", tree }, clicks);
  assertEquals(sidebar(s), { px: 300 });
  s.setDevice("tablet-landscape");
  assertEquals(sidebar(s), { px: 360 });
});

Deno.test("__proto__ layout and node names survive persistence and count toward the cap", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp" });
  const store = await LayoutProfileStore.open(dir, () => {});
  try {
    const section = Object.fromEntries([["__proto__", { px: 222 }]]);
    store.put("dev", "__proto__", "desktop", section);
    await store.flush();
    const raw = await Deno.readTextFile(store.pathOf("dev")!);
    assertEquals(new TextEncoder().encode(raw).length, store.bytes("dev"));
    const reopened = await LayoutProfileStore.open(dir, () => {});
    assertEquals(reopened.section("dev", "__proto__", "desktop"), section);
    assertThrows(
      () =>
        reopened.put(
          "dev",
          "__proto__",
          "desktop",
          Object.fromEntries([["x".repeat(LAYOUT_PROFILE_MAX_BYTES), { px: 1 }]]),
        ),
      ProfileRefusal,
    );
    assertEquals(reopened.section("dev", "__proto__", "desktop"), section);
    const specialTree = structuredClone(tree);
    assert(specialTree.children?.[0]);
    specialTree.children[0].id = "__proto__";
    const session = new Session({
      id: "s",
      scope: "read",
      device: "desktop",
      layout: { name: "__proto__", tree: specialTree },
      clicks: null,
      profile: reopened.device("dev"),
    });
    assertEquals(session.graph.overridden, ["__proto__"]);
    assertEquals(session.layout.tree.children?.[0].size, { px: 222 });
    await reopened.flush();
  } finally {
    await store.flush();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("symlinked profile directory is neither read nor written", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const root = await Deno.makeTempDir({ dir: resolve(".tmp") });
  const state = join(root, "state");
  const outside = join(root, "outside");
  try {
    await Deno.mkdir(state);
    await Deno.mkdir(outside);
    const target = join(outside, "dev.json");
    const original = JSON.stringify({ v: 1, layouts: { main: { desktop: { sidebar: { px: 200 } } } } });
    await Deno.writeTextFile(target, original);
    const makeLink = await prepareLink(root, join(state, "layout-profiles"), await Deno.realPath(outside));
    await makeLink();
    const logs: string[] = [];
    const store = await LayoutProfileStore.open(state, (line) => logs.push(line));
    assertEquals(store.section("dev", "main", "desktop"), {});
    store.put("dev", "main", "desktop", { sidebar: { px: 400 } });
    await store.flush();
    assertEquals(await Deno.readTextFile(target), original);
    assertEquals(logs.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("profile and planted temporary symlinks never write their targets", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const root = await Deno.makeTempDir({ dir: resolve(".tmp") });
  const profiles = join(root, "layout-profiles");
  const target = join(root, "target");
  try {
    await Deno.mkdir(profiles);
    await Deno.writeTextFile(target, "untouched");
    const absoluteTarget = await Deno.realPath(target);
    const first = join(root, "link-first");
    const second = join(root, "link-second");
    await Deno.mkdir(first);
    await Deno.mkdir(second);
    const profileLink = await prepareLink(first, join(profiles, "dev.json"), absoluteTarget);
    const tempLink = await prepareLink(second, join(profiles, "dev.json.tmp"), absoluteTarget);
    await profileLink();
    await tempLink();
    const logs: string[] = [];
    const store = await LayoutProfileStore.open(root, (line) => logs.push(line));
    assertEquals(store.section("dev", "main", "desktop"), {});
    assert(logs.some((line) => line.includes("symlink")));
    store.put("dev", "main", "desktop", { sidebar: { px: 340 } });
    await store.flush();
    assertEquals(await Deno.readTextFile(target), "untouched");
    assert((await Deno.lstat(join(profiles, "dev.json"))).isFile);
    assert((await Deno.lstat(join(profiles, "dev.json.tmp"))).isSymlink);
    if (Deno.build.os !== "windows") assertEquals((await Deno.stat(join(profiles, "dev.json"))).mode! & 0o777, 0o600);
    const reopened = await LayoutProfileStore.open(root, () => {});
    assertEquals(reopened.section("dev", "main", "desktop"), { sidebar: { px: 340 } });
    await reopened.flush();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

for (const kind of ["block", "terminal"] as const) {
  for (const device of ["desktop", "tablet-landscape"] as const) {
    Deno.test(`non-split ${kind} sidebar collapse state survives resize and restart on ${device}`, async () => {
      await Deno.mkdir(".tmp", { recursive: true });
      const dir = await Deno.makeTempDir({ dir: ".tmp" });
      const store = await LayoutProfileStore.open(dir, () => {});
      const layout: LayoutNode = {
        id: "root",
        type: "row",
        children: [
          {
            id: "sidebar",
            type: "block",
            size: { px: 268 },
            min: 44,
            max: 480,
            content: kind === "block" ? { mod: "sidebar-mod" } : { agent: "focused" },
          },
          { id: "content", type: "block", content: { mod: "content-mod" } },
        ],
      };
      const make = (profileStore: LayoutProfileStore, deviceClass: DeviceClass = device) =>
        new Session({
          id: "session",
          scope: "read",
          device: deviceClass,
          layout: { name: "custom", tree: layout },
          clicks: null,
          profile: profileStore.device("tablet"),
        });
      const node = (s: Session) => {
        const found = s.graph.routes.flatMap((r) => [...screenNodes(r.screen)]).find((n) => n.id === "sidebar");
        assert(found?.kind === kind);
        return found;
      };
      try {
        const s = make(store);
        assertEquals(node(s).size?.px, 268);
        assertEquals(node(s).collapsed, false);
        assert(
          s.layoutProfile({
            t: "layout",
            id: 1,
            action: "set",
            changes: [
              { node: "sidebar", size: { px: 44 }, collapsed: false },
            ],
          }).ok,
        );
        assertEquals(node(s).size?.px, 44);
        assertEquals(node(s).collapsed, false);
        assert(
          s.layoutProfile({
            t: "layout",
            id: 2,
            action: "set",
            changes: [
              { node: "sidebar", collapsed: true },
            ],
          }).ok,
        );
        assertEquals(node(s).size?.px, 44);
        assertEquals(node(s).collapsed, true);
        assert(
          s.layoutProfile({
            t: "layout",
            id: 3,
            action: "set",
            changes: [
              { node: "sidebar", size: { px: 194 } },
            ],
          }).ok,
        );
        assertEquals(node(s).size?.px, 44);
        assertEquals(node(s).collapsed, true);
        assertEquals(store.section("tablet", "custom", device).sidebar, { px: 194, collapsed: true });
        assert(
          s.layoutProfile({
            t: "layout",
            id: 4,
            action: "set",
            changes: [
              { node: "sidebar", size: { px: 194 }, collapsed: false },
            ],
          }).ok,
        );
        assertEquals(node(s).size?.px, 194);
        assertEquals(node(s).collapsed, false);
        await store.flush();
        const reopened = await LayoutProfileStore.open(dir, () => {});
        const restored = make(reopened);
        assertEquals(node(restored).size?.px, 194);
        assertEquals(node(restored).collapsed, false);
        assertEquals(reopened.section("tablet", "custom", device).sidebar, { px: 194, collapsed: false });
        await reopened.flush();
        const portrait = make(reopened, "tablet-portrait");
        assertEquals(node(portrait).size?.px, 44);
        assertEquals(node(portrait).collapsed, true);
        const phone = make(reopened, "phone");
        for (const route of phone.graph.routes) {
          for (const screen of screenNodes(route.screen)) assert(!Object.hasOwn(screen, "collapsed"));
        }
      } finally {
        await store.flush();
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
}
