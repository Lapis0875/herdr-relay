import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import type { BridgeMessage, DeviceClass, HostState } from "@herdr-relay/protocol";
import { applyPatch } from "../../../../web/src/app/jsonpatch.ts";
import type { SessionConnection } from "../../../src/server/connection.ts";
import type { HerdrData, SnapshotState } from "../../../src/views/data.ts";
import { ViewManager } from "../../../src/views/manager.ts";
import { fixtureState } from "../../fixtures/state.ts";

class Conn implements SessionConnection {
  readonly via = "local" as const;
  readonly bufferedAmount = 0;
  readonly messages: BridgeMessage[] = [];
  readonly device: { id: string; name: string; scope: "act" };

  constructor(readonly id: string) {
    this.device = { id, name: id, scope: "act" };
  }

  send(message: BridgeMessage) {
    this.messages.push(structuredClone(message));
    return true;
  }
  sendBinary() {
    return true;
  }
  close() {}

  state(): SnapshotState {
    let state: SnapshotState | undefined;
    for (const message of this.messages) {
      if (message.t === "snapshot") {
        const { spaces, panes, agents, terminals, focused, shared } = message;
        state = { spaces, panes, agents, terminals, focused, shared };
      } else if (message.t === "patch" && message.state) {
        assert(state, `${this.id}: state patch without snapshot`);
        state = applyPatch(state, message.state);
      }
    }
    assert(state, `${this.id}: missing snapshot`);
    return state;
  }

  ack(id: number) {
    assert(this.messages.some((m) => m.t === "ack" && m.id === id && m.ok), `${this.id}: missing successful ack ${id}`);
  }
}

Deno.test("device focus stays private while host state follows the acting lead", async () => {
  const state = fixtureState("fixtures/generic-home", ".tmp", "main");
  state.spaces[0].tabs[0].zoomed = true;
  state.panes[0].zoomed = true;
  state.spaces[0].tabs.push({
    ...state.spaces[0].tabs[0],
    id: "s1/t2",
    index: 2,
    name: "Second",
    active: false,
    zoomed: false,
  });
  state.panes.push({ ...state.panes[0], pane: "p2", terminal: "t2", tab: "s1/t2", focused: false, zoomed: false });
  const original = structuredClone(state);
  let passthroughs = 0;
  let changes = 0;
  let stateFor!: (folder: string) => HostState;
  const data: HerdrData = {
    layout: () => ({ layout: { name: "main", tree: state.layout }, clicks: null }),
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
    subscribe: () => () => {},
    emit: () => {},
    sessionClosed: () => {},
    passthrough: () => {
      passthroughs++;
      return Promise.reject(new Error("unexpected passthrough"));
    },
    rpc: () => Promise.resolve(null),
  };
  const manager = await ViewManager.start({
    data,
    roots: [],
    flushMs: 1,
    hosts: (wiring) => {
      stateFor = wiring.stateFor;
      return {
        create() {},
        close: () => true,
        event: () => true,
        command: () => true,
        shared() {},
        stateChanged: () => {
          changes++;
        },
        statuses: () => [],
        info: () => null,
      };
    },
  });
  const a = new Conn("device-a");
  const b = new Conn("device-b");
  const phone = new Conn("phone");
  const open = (conn: Conn, deviceClass: DeviceClass) =>
    manager.open(conn, {
      t: "hello",
      v: 1,
      device: conn.device.id,
      class: deviceClass,
      viewport: { w: 1280, h: 800, dpr: 1 },
    });
  const active = (view: Pick<SnapshotState, "spaces">) => view.spaces[0].tabs.map((tab) => tab.active);
  const assertPhoneUnzoomed = () => {
    const view = phone.state();
    assertEquals(view.spaces.flatMap((space) => space.tabs.map((tab) => tab.zoomed)), [false, false]);
    assertEquals(view.panes.map((pane) => pane.zoomed), [false, false]);
  };
  try {
    await open(a, "desktop");
    await open(b, "desktop");
    await open(phone, "phone");
    await delay(30);
    assertEquals(active(a.state()), [true, false]);
    assertEquals(active(b.state()), [true, false]);
    assertPhoneUnzoomed();

    const beforeA = changes;
    await manager.message(a, { t: "command", id: 1, name: "tab.select", args: { id: "s1/t2" } });
    assertEquals(active(stateFor("tabs")), [false, true]);
    assertEquals(stateFor("tabs").focused?.tab, "s1/t2");
    assert(changes > beforeA, "host must be notified when A acts");
    await delay(30);
    a.ack(1);
    assert(a.messages.some((m) => m.t === "patch" && m.state?.length), "A must receive a state patch");
    assertEquals(active(a.state()), [false, true]);
    assertEquals(a.state().focused?.tab, "s1/t2");
    assertEquals(active(b.state()), [true, false]);
    assertEquals(b.state().focused?.tab, "s1/t1");
    assertPhoneUnzoomed();

    const beforeB = changes;
    await manager.message(b, { t: "command", id: 2, name: "tab.select", args: { id: "s1/t1" } });
    assertEquals(active(stateFor("tabs")), [true, false]);
    assertEquals(stateFor("tabs").focused?.tab, "s1/t1");
    assert(changes > beforeB, "host must be notified when B becomes lead");
    await delay(30);
    b.ack(2);
    assertEquals(active(b.state()), [true, false]);
    assertEquals(b.state().focused?.tab, "s1/t1");
    assertEquals(active(a.state()), [false, true]);
    assertEquals(a.state().focused?.tab, "s1/t2");
    assertPhoneUnzoomed();

    await manager.message(phone, { t: "command", id: 3, name: "pane.zoom", args: {} });
    await delay(30);
    phone.ack(3);
    assertPhoneUnzoomed();
    assertEquals(passthroughs, 0);
    assertEquals(state, original);
  } finally {
    manager.stop();
  }
});
