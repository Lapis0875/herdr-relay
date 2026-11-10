import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import type { BridgeMessage, HostState } from "@herdr-relay/protocol";
import type { SessionConnection } from "../../../src/server/connection.ts";
import type { HerdrData } from "../../../src/views/data.ts";
import { ViewManager } from "../../../src/views/manager.ts";
import { fixtureState } from "../../fixtures/state.ts";

Deno.test("device tab selection updates host state and device patch without passthrough", async () => {
  const state = fixtureState("fixtures/generic-home", ".tmp", "main");
  const firstTab = state.spaces[0].tabs[0];
  state.spaces[0].tabs.push({ ...firstTab, id: "s1/t2", index: 2, name: "Second", active: false });
  state.panes.push({ ...state.panes[0], pane: "p2", terminal: "t2", tab: "s1/t2", focused: false });
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
  const messages: BridgeMessage[] = [];
  const conn: SessionConnection = {
    id: "device-session",
    via: "local",
    bufferedAmount: 0,
    device: { id: "device", name: "device", scope: "act" },
    send: (message) => {
      messages.push(structuredClone(message));
      return true;
    },
    sendBinary: () => true,
    close: () => {},
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
  try {
    await manager.open(conn, {
      t: "hello",
      v: 1,
      device: conn.device.id,
      class: "desktop",
      viewport: { w: 1280, h: 800, dpr: 1 },
    });
    await delay(30);
    messages.length = 0;
    const before = changes;
    assertEquals(stateFor("tabs").spaces[0].tabs.map((tab) => tab.active), [true, false]);
    await manager.message(conn, { t: "command", id: 1, name: "tab.select", args: { id: "s1/t2" } });
    assertEquals(stateFor("tabs").spaces[0].tabs.map((tab) => tab.active), [false, true]);
    assert(changes > before, "host must be notified of the focus change");
    await delay(30);
    assert(messages.some((message) => message.t === "ack" && message.id === 1 && message.ok));
    assert(
      messages.some((message) =>
        message.t === "patch" &&
        message.state?.some((op) => op.path === "/spaces/0/tabs/1/active" && op.op === "replace" && op.value === true)
      ),
      "missing active-tab state patch",
    );
    assertEquals(passthroughs, 0);
    assertEquals(state, original);
  } finally {
    manager.stop();
  }
});
