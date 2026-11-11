import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { join, resolve } from "@std/path";
import { type RecordedTree, toElementTree } from "@herdr-relay/protocol";
import { HostSupervisor } from "../../src/hosts/supervisor.ts";
import type { HerdrData } from "../../src/views/data.ts";
import { ViewManager } from "../../src/views/manager.ts";
import { fixtureState } from "../fixtures/state.ts";

Deno.test({
  name: "modhost records scroll handles and enforces release",
  ignore: Deno.build.os !== "darwin",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await Deno.mkdir(".tmp", { recursive: true });
    const run = await Deno.makeTempDir({ dir: resolve(".tmp"), prefix: "scroll-probe-" });
    const app = join(run, "app");
    const mod = join(app, "mods", "probe");
    await Deno.mkdir(mod, { recursive: true });
    await Deno.writeTextFile(
      join(mod, "main.js"),
      `
import { View, div } from "gpui-kit";
import { ScrollHandle } from "gpui-base";
export default class Probe extends View {
  render() {
    const a = ScrollHandle.new(), b = ScrollHandle.new(), released = ScrollHandle.new();
    const first = div().track_scroll(a).child("one");
    a.scroll_to_item(0);
    const second = div().track_scroll(b).child("two");
    b.scroll_to_item(1);
    const result = released.release();
    let useThrows = false, releaseThrows = false;
    try { released.scroll_to_item(0); } catch (e) { useThrows = e instanceof TypeError; }
    try { released.release(); } catch (e) { releaseThrows = e instanceof TypeError; }
    return div().child(first).child(second).child(JSON.stringify([result, useThrows, releaseThrows]));
  }
}`,
    );
    const state = fixtureState("fixtures/generic-home", run, "main");
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
      rpc: () => Promise.reject(new Error("unexpected RPC")),
    };
    let supervisor!: HostSupervisor;
    let recorded: RecordedTree | undefined;
    const errors: string[] = [];
    const manager = await ViewManager.start({
      data,
      roots: [],
      hosts: async (wiring) => {
        supervisor = await HostSupervisor.create({
          appHome: app,
          modhost: "packages/modhost",
          run,
          stateDir: run,
          stateFor: wiring.stateFor,
          handlers: {
            ...wiring.handlers,
            tree: (host, message) => {
              recorded = message.tree;
              wiring.handlers.tree?.(host, message);
            },
            error: (host, message) => {
              errors.push(`${host.folder}: ${message.error}`);
              wiring.handlers.error?.(host, message);
            },
          },
        });
        return supervisor;
      },
    });
    try {
      supervisor.create("probe:probe", {}, null);
      const deadline = Date.now() + 15000;
      while (!recorded && !errors.length && Date.now() < deadline) await delay(20);
      assertEquals(errors, []);
      assert(recorded, "probe must render a recorded tree");
      const raw = JSON.stringify(recorded);
      assert(raw.includes('"track_scroll"'));
      assert(raw.includes('"scroll_to":{"seq":1,"index":0}'));
      assert(raw.includes('"scroll_to":{"seq":2,"index":1}'));
      const converted = toElementTree(recorded);
      assertEquals(converted.diagnostics, []);
      const tree = JSON.stringify(converted.tree);
      assert(tree.includes('"scrollTo":{"seq":1,"index":0}'));
      assert(tree.includes('"scrollTo":{"seq":2,"index":1}'));
      assert(tree.includes("[true,true,true]"));
    } finally {
      manager.stop();
      await supervisor.stop();
      await Deno.remove(run, { recursive: true });
    }
  },
});
