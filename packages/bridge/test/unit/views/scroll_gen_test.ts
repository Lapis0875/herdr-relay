import { assert, assertEquals, assertMatch } from "@std/assert";
import { delay } from "@std/async";
import type { BridgeMessage, RecordedTree } from "@herdr-relay/protocol";
import type { HostHandlers } from "../../../src/hosts/supervisor.ts";
import type { SessionConnection } from "../../../src/server/connection.ts";
import type { HerdrData } from "../../../src/views/data.ts";
import { ViewManager } from "../../../src/views/manager.ts";
import { fixtureState } from "../../fixtures/state.ts";

Deno.test("scroll request generations follow host restarts and cannot be forged by a host", async () => {
  const state = fixtureState("fixtures/generic-home", ".tmp", "main");
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
    passthrough: () => Promise.reject(new Error("unexpected passthrough")),
    rpc: () => Promise.resolve(null),
  };
  const messages: BridgeMessage[] = [];
  const logs: string[] = [];
  const conn: SessionConnection = {
    id: "scroll-device",
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
  let handlers!: HostHandlers;
  const manager = await ViewManager.start({
    data,
    roots: [],
    flushMs: 1,
    log: (line) => logs.push(line),
    hosts: (wiring) => {
      handlers = wiring.handlers;
      return {
        create() {},
        close: () => true,
        event: () => true,
        command: () => true,
        shared() {},
        stateChanged() {},
        statuses: () => [],
        info: () => null,
      };
    },
  });
  const tree = (gen?: string): RecordedTree => ({
    tag: "div",
    style: [["track_scroll", { handle: "ScrollHandle:1", scroll_to: { seq: 1, index: 0, ...(gen ? { gen } : {}) } }]],
    handlers: [],
    children: [{ text: "tab" }],
  });
  const sendTree = (generation: number, recorded: RecordedTree) => {
    const host = { folder: "tabs", generation };
    handlers.started?.(host);
    handlers.tree?.(host, { t: "tree", copy: "tabs:tabs", n: 1, ms: 0, tree: recorded });
  };
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
    sendTree(1, tree());
    await delay(30);
    const first = messages.find((m) => m.t === "view.tree" && m.view === "tabs:tabs");
    assert(first?.t === "view.tree");
    assertEquals(first.tree.scrollTo?.seq, 1);
    const firstGen = first.tree.scrollTo?.gen;
    assert(typeof firstGen === "string");
    assertMatch(firstGen, /^[^.]+\.1$/);
    messages.length = 0;
    sendTree(2, tree());
    await delay(30);
    const second = messages.find((m) => m.t === "view.tree" && m.view === "tabs:tabs");
    assert(second?.t === "view.tree");
    assertEquals(second.tree.scrollTo?.gen, firstGen.replace(/\.1$/, ".2"));
    messages.length = 0;
    sendTree(2, tree("forged"));
    await delay(30);
    assert(logs.some((line) => line.includes("track_scroll") && line.includes("dropped")));
    const forged = messages.find((m) => m.t === "view.tree" && m.view === "tabs:tabs");
    assert(forged?.t === "view.tree");
    assertEquals(forged.tree.scrollTo, undefined);
  } finally {
    manager.stop();
  }
});
