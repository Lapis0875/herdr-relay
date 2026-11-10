import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { delay } from "@std/async";
import type { BridgeMessage, DeviceClass, LayoutNode, Origin, Scope } from "@herdr-relay/protocol";
import type { HostHandlers } from "../../../src/hosts/supervisor.ts";
import { Auth, DeviceStore, TicketBook } from "../../../src/auth/mod.ts";
import { type RevocableSessions, startServer } from "../../../src/server/server.ts";
import type { SessionConnection } from "../../../src/server/connection.ts";
import { LayoutProfileStore } from "../../../src/session/profiles.ts";
import type { HerdrChange, HerdrData } from "../../../src/views/data.ts";
import { ViewManager } from "../../../src/views/manager.ts";
import { fixtureState } from "../../fixtures/state.ts";

const tree: LayoutNode = JSON.parse(Deno.readTextFileSync("fixtures/layouts/lstack-herdr.json"));
class Conn implements SessionConnection {
  readonly via = "local" as const;
  readonly bufferedAmount = 0;
  readonly messages: BridgeMessage[] = [];
  readonly device: { id: string; name: string; scope: Scope };
  constructor(readonly id: string, device: string, scope: Scope = "read") {
    this.device = { id: device, name: device, scope };
  }
  send(message: BridgeMessage) {
    this.messages.push(structuredClone(message));
    return true;
  }
  sendBinary() {
    return true;
  }
  close() {}
  ack(id: number) {
    const ack = this.messages.find((m) => m.t === "ack" && m.id === id);
    assert(ack && ack.t === "ack", `missing ack ${id}`);
    return ack;
  }
}

async function harness(store = LayoutProfileStore.memory(), layoutTree: LayoutNode = tree) {
  const state = fixtureState("fixtures/generic-home", ".tmp", "main");
  let listener: ((change: HerdrChange) => void) | undefined;
  const data: HerdrData = {
    layout: () => ({ layout: { name: "lstack-herdr", tree: layoutTree }, clicks: null }),
    world: () => ({ spaces: state.spaces, panes: state.panes, agents: state.agents, focused: state.focused }),
    commands: () => state.commands,
    hostState: (folder) => ({ ...state, folder }),
    look: () => ({
      theme: state.theme,
      settings: state.settings,
      fonts: { ui: "sans-serif", mono: "monospace", terminal: "monospace" },
    }),
    snapshot: () => ({
      spaces: state.spaces,
      panes: state.panes,
      agents: state.agents,
      terminals: state.terminals,
      focused: state.focused,
      shared: state.shared,
    }),
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    emit: () => {},
    sessionClosed: () => {},
    passthrough: () => Promise.reject(new Error("unexpected passthrough")),
    rpc: () => Promise.resolve(null),
  };
  let handlers!: HostHandlers;
  let origin: Origin | undefined;
  const manager = await ViewManager.start({
    data,
    roots: [],
    profiles: store,
    flushMs: 1,
    hosts: (wiring) => {
      handlers = wiring.handlers;
      return {
        create() {},
        close: () => true,
        event: (_copy, _handler, _args, value) => {
          origin = value;
          return true;
        },
        command: () => true,
        shared() {},
        stateChanged() {},
        statuses: () => [],
        info: () => null,
      };
    },
  });
  const open = (conn: Conn, deviceClass: DeviceClass = "desktop") =>
    manager.open(conn, {
      t: "hello",
      v: 1,
      device: conn.device.id,
      class: deviceClass,
      viewport: { w: 1280, h: 800, dpr: 1 },
    });
  return {
    manager,
    handlers,
    open,
    getOrigin: () => origin,
    editLayout(next: LayoutNode) {
      layoutTree = next;
      listener?.({ kind: "layout" });
    },
  };
}

Deno.test("read device may set profile; other sessions receive screens; invalid changes are refused", async () => {
  const store = LayoutProfileStore.memory();
  const mainTree: LayoutNode = JSON.parse(Deno.readTextFileSync("fixtures/generic-home/layouts/main.json"));
  const { manager, open } = await harness(store, mainTree);
  const a = new Conn("a", "same");
  const b = new Conn("b", "same");
  const other = new Conn("c", "other");
  try {
    await open(a);
    await open(b);
    await open(other);
    await manager.message(a, { t: "layout", id: 1, action: "set", changes: [{ node: "sidebar", size: { px: 360 } }] });
    assertEquals(a.ack(1).ok, true);
    assertEquals(store.section("same", "lstack-herdr", "desktop"), { sidebar: { px: 360 } });
    await delay(30);
    for (const conn of [a, b]) {
      assert(conn.messages.some((m) => m.t === "patch" && m.screens?.overridden?.includes("sidebar")), conn.id);
    }
    assertEquals(store.section("other", "lstack-herdr", "desktop"), {});
    await manager.message(a, { t: "layout", id: 2, action: "set", changes: [{ node: "brand", size: { px: 100 } }] });
    await manager.message(a, {
      t: "layout",
      id: 3,
      action: "set",
      changes: [{ node: "sidebar", size: { weight: 2 } }],
    });
    await manager.message(a, { t: "layout", id: 4, action: "set", changes: [{ node: "spaces", collapsed: true }] });
    assertStringIncludes(a.ack(4).message ?? "", "cannot collapse");
    for (const id of [2, 3, 4]) {
      assertEquals(a.ack(id).ok, false);
      assertEquals(a.ack(id).error, "refused");
    }
    assertEquals(store.section("same", "lstack-herdr", "desktop"), { sidebar: { px: 360 } });
  } finally {
    manager.stop();
  }
});

Deno.test("21st layout message in a second is refused with a rate-limit acknowledgement", async () => {
  const { manager, open } = await harness();
  const a = new Conn("rate", "rate");
  try {
    await open(a);
    for (let id = 1; id <= 21; id++) {
      await manager.message(a, {
        t: "layout",
        id,
        action: "set",
        changes: [{ node: "sidebar", size: { px: 300 + id } }],
      });
    }
    for (let id = 1; id <= 20; id++) assertEquals(a.ack(id).ok, true);
    assertEquals(a.ack(21).ok, false);
    assertStringIncludes(a.ack(21).message ?? "", "over 20 layout changes per second");
  } finally {
    manager.stop();
  }
});

Deno.test("mod resize uses authenticated event origin only; phone and transient non-overridable targets do not persist", async () => {
  const store = LayoutProfileStore.memory();
  const { manager, handlers, open, getOrigin } = await harness(store);
  const a = new Conn("origin", "device-a", "act");
  const b = new Conn("other", "device-b", "act");
  const phone = new Conn("phone", "device-phone", "act");
  const host = { folder: "lstack-herdr-cockpit", generation: 1 };
  const copy = "lstack-herdr-cockpit:home-board";
  try {
    await open(a);
    await open(b);
    await open(phone, "phone");
    handlers.started?.(host);
    handlers.tree?.(host, {
      t: "tree",
      copy,
      n: 1,
      ms: 0,
      tree: { tag: "div", style: [], handlers: [{ event: "on_click", id: 7 }], children: [] },
    });
    await delay(30);
    const click = async (conn: Conn, id: number) => {
      const view = conn.messages.find((m) => m.t === "view.tree" && m.view === copy);
      assert(view && view.t === "view.tree");
      const handler = view.tree.on?.click;
      assert(typeof handler === "number");
      await manager.message(conn, {
        t: "event",
        id,
        kind: "click",
        view: copy,
        handler,
        data: {
          click_count: 1,
          modifiers: { shift: false, control: false, alt: false, platform: false, function: false },
        },
      });
      const value = getOrigin();
      assert(value);
      return value;
    };
    const token = await click(a, 1);
    const emit = (id: string, px: number, origin?: Origin) =>
      handlers.emit?.(host, {
        t: "emit",
        copy,
        method: "run",
        args: ["layout.resize", { id, px }],
        ...(origin ? { origin } : {}),
      });
    emit("sidebar", 420, token);
    assertEquals(store.section("device-a", "lstack-herdr", "desktop"), { sidebar: { px: 420 } });
    assertEquals(store.section("device-b", "lstack-herdr", "desktop"), {});
    emit("sidebar", 440);
    emit("sidebar", 450, { session: "origin" });
    assertEquals(store.section("device-a", "lstack-herdr", "desktop"), { sidebar: { px: 420 } });
    emit("brand", 60, token);
    assertEquals(store.section("device-a", "lstack-herdr", "desktop"), { sidebar: { px: 420 } });
    const originTree = manager.session(a.id)?.layout.tree;
    const otherTree = manager.session(b.id)?.layout.tree;
    assert(originTree && otherTree);
    assertEquals(originTree.children?.[0].children?.find((n) => n.id === "brand")?.size, { px: 60 });
    assertEquals(otherTree.children?.[0].children?.find((n) => n.id === "brand")?.size, { px: 46 });
    const phoneToken = await click(phone, 2);
    emit("sidebar", 400, phoneToken);
    assertEquals(store.section("device-phone", "lstack-herdr", "phone"), {});
  } finally {
    manager.stop();
  }
});

Deno.test("revocation ends sessions but a confirmed sweep deletes the persisted profile", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp" });
  const store = await LayoutProfileStore.open(dir, () => {});
  const { manager, open } = await harness(store);
  const a = new Conn("revoke", "device-a");
  try {
    await open(a);
    await manager.message(a, { t: "layout", id: 1, action: "set", changes: [{ node: "sidebar", size: { px: 360 } }] });
    await store.flush();
    assert((await Deno.stat(store.pathOf("device-a")!)).isFile);
    manager.revokeDevice("device-a");
    await store.flush();
    assert((await Deno.stat(store.pathOf("device-a")!)).isFile);
    assertEquals(store.section("device-a", "lstack-herdr", "desktop"), { sidebar: { px: 360 } });
    manager.retainDevices((id) => id === "local");
    await store.flush();
    assertEquals(store.section("device-a", "lstack-herdr", "desktop"), {});
    try {
      await Deno.stat(store.pathOf("device-a")!);
      throw new Error("profile file remains");
    } catch (error) {
      assert(error instanceof Deno.errors.NotFound);
    }
  } finally {
    manager.stop();
    await store.flush();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a malformed devices list does not sweep saved profiles", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp" });
  const profiles = await LayoutProfileStore.open(dir, () => {});
  profiles.device("paired").put("lstack-herdr", "desktop", { sidebar: { px: 360 } });
  profiles.device("local").put("lstack-herdr", "desktop", { sidebar: { px: 320 } });
  await profiles.flush();
  const devices = new DeviceStore(dir);
  await Deno.writeTextFile(devices.path, "not valid JSON");
  const auth = new Auth({
    port: 0,
    token: "test-token",
    devices,
    tickets: new TicketBook(),
    pairing: null,
    tailnetEnabled: false,
    peer: () => Promise.resolve(false),
  });
  const { manager } = await harness(profiles);
  const server = startServer({ port: 0, auth, sessions: manager, webRoot: null, log: () => {} });
  try {
    await delay(2300);
    assert(devices.error !== null);
    assertEquals(profiles.section("paired", "lstack-herdr", "desktop"), { sidebar: { px: 360 } });
    assertEquals(profiles.section("local", "lstack-herdr", "desktop"), { sidebar: { px: 320 } });
  } finally {
    await server.shutdown();
    manager.stop();
    await profiles.flush();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("weight pair is one rate-limited change and produces one screens patch", async () => {
  const mainTree: LayoutNode = JSON.parse(Deno.readTextFileSync("fixtures/generic-home/layouts/main.json"));
  const store = LayoutProfileStore.memory();
  const { manager, open } = await harness(store, mainTree);
  const conn = new Conn("pair", "pair");
  try {
    await open(conn);
    for (let id = 1; id <= 19; id++) {
      await manager.message(conn, {
        t: "layout",
        id,
        action: "set",
        changes: [{ node: "sidebar", size: { px: 280 + id } }],
      });
      assertEquals(conn.ack(id).ok, true);
    }
    await delay(30);
    conn.messages.length = 0;
    const changes = [{ node: "spaces", size: { weight: 2 } }, { node: "agents", size: { weight: 3 } }];
    await manager.message(conn, { t: "layout", id: 20, action: "set", changes });
    assertEquals(conn.ack(20).ok, true);
    await delay(30);
    assertEquals(conn.messages.filter((m) => m.t === "patch" && m.screens).length, 1);
    const before = store.section("pair", "lstack-herdr", "desktop");
    assertEquals(before.spaces, { weight: 2 });
    assertEquals(before.agents, { weight: 3 });
    await manager.message(conn, {
      t: "layout",
      id: 21,
      action: "set",
      changes: [
        { node: "spaces", size: { weight: 5 } },
        { node: "agents", size: { weight: 6 } },
      ],
    });
    assertEquals(conn.ack(21).ok, false);
    assertStringIncludes(conn.ack(21).message ?? "", "over 20 layout changes per second");
    assertEquals(store.section("pair", "lstack-herdr", "desktop"), before);
  } finally {
    manager.stop();
  }
});

Deno.test("multi-change duplicate, wrong kind and cap refusals leave the whole profile unchanged", async () => {
  const mainTree: LayoutNode = JSON.parse(Deno.readTextFileSync("fixtures/generic-home/layouts/main.json"));
  const store = LayoutProfileStore.memory();
  const { manager, open } = await harness(store, mainTree);
  const conn = new Conn("atomic", "atomic");
  try {
    await open(conn);
    const bad = [
      [{ node: "spaces", size: { weight: 2 } }, { node: "spaces", size: { weight: 3 } }],
      [{ node: "spaces", size: { weight: 2 } }, { node: "sidebar", size: { weight: 4 } }],
    ];
    for (let i = 0; i < bad.length; i++) {
      await manager.message(conn, { t: "layout", id: i + 1, action: "set", changes: bad[i] });
      assertEquals(conn.ack(i + 1).ok, false);
      assertEquals(store.section("atomic", "lstack-herdr", "desktop"), {});
    }
    const filler = "x".repeat(65440);
    store.put("atomic", "lstack-herdr", "desktop", { [filler]: { px: 1 } });
    manager.session(conn.id)!.reloadProfile();
    const before = store.section("atomic", "lstack-herdr", "desktop");
    await manager.message(conn, {
      t: "layout",
      id: 3,
      action: "set",
      changes: [
        { node: "spaces", size: { weight: 2 } },
        { node: "agents", size: { weight: 3 } },
      ],
    });
    assertEquals(conn.ack(3).ok, false);
    assertEquals(store.section("atomic", "lstack-herdr", "desktop"), before);
  } finally {
    manager.stop();
  }
});

Deno.test("same-name layout edits send screens with current resize metadata", async () => {
  const mainTree: LayoutNode = JSON.parse(Deno.readTextFileSync("fixtures/generic-home/layouts/main.json"));
  const { manager, open, editLayout } = await harness(LayoutProfileStore.memory(), mainTree);
  const conn = new Conn("edit", "edit");
  try {
    await open(conn);
    await delay(30);
    conn.messages.length = 0;
    editLayout(structuredClone(mainTree));
    await delay(30);
    const patch = conn.messages.find((m) => m.t === "patch" && m.screens);
    assert(patch && patch.t === "patch" && patch.screens);
    assertEquals(patch.screens.layout, "lstack-herdr");
    assertStringIncludes(JSON.stringify(patch.screens), '"resize":{"kind":"weight","collapsible":false}');
  } finally {
    manager.stop();
  }
});

Deno.test("tailnet session ends on unreadable device list but profile survives until confirmed removal", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp" });
  const devices = new DeviceStore(dir);
  const paired = (await devices.add("tablet", "read")).device;
  const validDevices = await Deno.readTextFile(devices.path);
  const store = await LayoutProfileStore.open(dir, () => {});
  store.put(paired.id, "lstack-herdr", "desktop", { sidebar: { px: 360 } });
  await store.flush();
  const { manager } = await harness(store);
  const portListener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (portListener.addr as Deno.NetAddr).port;
  portListener.close();
  const dns = "mac.tailnet-test.ts.net";
  const auth = new Auth({
    port,
    token: "test-token",
    devices,
    tickets: new TicketBook(),
    pairing: null,
    tailnetEnabled: true,
    peer: () => Promise.resolve(true),
    tailnet: { owner: "owner@github", dns },
  });
  let sessionId = "";
  const sessions: RevocableSessions = {
    open: (c, hello) => {
      sessionId = c.id;
      return manager.open(c, hello);
    },
    message: (c, m) => manager.message(c, m),
    binary: (c, frame) => manager.binary(c, frame),
    close: (c, code, reason) => manager.close(c, code, reason),
    revokeDevice: (id) => manager.revokeDevice(id),
    retainDevices: (paired) => manager.retainDevices(paired),
  };
  const server = startServer({ port, auth, sessions, webRoot: null, log: () => {} });
  const socket = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const ticket = auth.tickets.mint({ via: "tailnet", device: paired });
    const request = [
      `GET /herdr-relay/ws?ticket=${ticket} HTTP/1.1`,
      `host: ${dns}`,
      "tailscale-user-login: owner@github",
      `origin: https://${dns}`,
      "upgrade: websocket",
      "connection: Upgrade",
      "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version: 13",
      "",
      "",
    ].join("\r\n");
    await socket.write(new TextEncoder().encode(request));
    const response = new Uint8Array(4096);
    const read = await socket.read(response);
    assert(read && new TextDecoder().decode(response.subarray(0, read)).includes("101 Switching Protocols"));
    const hello = new TextEncoder().encode(JSON.stringify({
      t: "hello",
      v: 1,
      device: paired.id,
      class: "desktop",
      viewport: { w: 1280, h: 800, dpr: 1 },
    }));
    assert(hello.length < 126);
    const frame = new Uint8Array(6 + hello.length);
    frame.set([0x81, 0x80 | hello.length, 1, 2, 3, 4]);
    for (let i = 0; i < hello.length; i++) frame[6 + i] = hello[i] ^ frame[2 + i % 4];
    await socket.write(frame);
    for (let i = 0; i < 50 && !sessionId; i++) await delay(20);
    assert(sessionId && manager.session(sessionId));
    await Deno.writeTextFile(devices.path, "broken");
    await delay(2300);
    assert(devices.error !== null);
    assertEquals(manager.session(sessionId), undefined);
    assertEquals(store.section(paired.id, "lstack-herdr", "desktop"), { sidebar: { px: 360 } });
    assert((await Deno.stat(store.pathOf(paired.id)!)).isFile);
    await Deno.writeTextFile(devices.path, validDevices);
    await delay(2300);
    assertEquals(devices.error, null);
    assert((await Deno.stat(store.pathOf(paired.id)!)).isFile);
    await devices.revoke(paired.id);
    await delay(2300);
    await store.flush();
    assertEquals(store.section(paired.id, "lstack-herdr", "desktop"), {});
    try {
      await Deno.stat(store.pathOf(paired.id)!);
      throw new Error("profile remains");
    } catch (error) {
      assert(error instanceof Deno.errors.NotFound);
    }
  } finally {
    try {
      socket.close();
    } catch { /* server may have closed it */ }
    await server.shutdown();
    manager.stop();
    await store.flush();
    await Deno.remove(dir, { recursive: true });
  }
});
