import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { join, resolve } from "@std/path";
import type { BridgeMessage, LayoutNode, Scope } from "@herdr-relay/protocol";
import { HostSupervisor } from "../../src/hosts/supervisor.ts";
import type { SessionConnection } from "../../src/server/connection.ts";
import type { HerdrData, ResolvedOrigin } from "../../src/views/data.ts";
import { ViewManager } from "../../src/views/manager.ts";
import { fixtureState } from "../fixtures/state.ts";

Deno.test({
  name: "S19 origin capabilities reject raw act ids, cross-folder replay, and expired replay",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    await Deno.mkdir(".tmp", { recursive: true });
    const dir = await Deno.makeTempDir({ dir: resolve(".tmp"), prefix: "origin-security-" });
    const app = join(dir, "app");
    const run = join(dir, "run");
    for (const folder of ["evil", "thief"]) {
      const path = join(app, "mods", folder);
      await Deno.mkdir(path, { recursive: true });
      await Deno.copyFile("fixtures/probe-mods/origin/main.js", join(path, "main.js"));
    }
    await Deno.mkdir(run);
    const runtime = await Deno.realPath("packages/modhost/src/runtime.js");
    const state = fixtureState("fixtures/generic-home", dir, "main");
    const tree: LayoutNode = {
      id: "root",
      type: "row",
      children: [
        { id: "probe", type: "block", content: { mod: "evil", props: { runtime } } },
        { id: "thief-probe", type: "block", content: { mod: "thief", props: { runtime } } },
      ],
    };
    const calls: { marker: string; token: unknown; origin: ResolvedOrigin | null }[] = [];
    const logs: string[] = [];
    let passthroughs = 0;
    const data: HerdrData = {
      layout: () => ({ layout: { name: "security", tree }, clicks: null }),
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
        return Promise.resolve();
      },
      rpc: (_host, msg, origin) => {
        calls.push({ marker: String(msg.args[0]), token: msg.args[1], origin });
        return Promise.resolve(null);
      },
    };
    let supervisor!: HostSupervisor;
    const manager = await ViewManager.start({
      data,
      roots: [],
      log: (line) => logs.push(line),
      hosts: async (wiring) => {
        supervisor = await HostSupervisor.create({
          appHome: app,
          modhost: "packages/modhost",
          run,
          stateDir: run,
          stateFor: wiring.stateFor,
          handlers: wiring.handlers,
        });
        return supervisor;
      },
    });
    const readMessages: BridgeMessage[] = [];
    const actMessages: BridgeMessage[] = [];
    function connection(id: string, scope: Scope, messages: BridgeMessage[]): SessionConnection {
      return {
        id,
        device: { id: `device-${scope}`, name: scope, scope },
        via: "local",
        bufferedAmount: 0,
        send: (msg) => {
          messages.push(msg);
          return true;
        },
        sendBinary: () => true,
        close: () => {},
      };
    }
    const read = connection("sess-read", "read", readMessages);
    const act = connection("sess-act", "act", actMessages);
    const hello = {
      t: "hello" as const,
      v: 1 as const,
      class: "desktop" as const,
      viewport: { w: 1280, h: 800, dpr: 1 },
    };
    try {
      await manager.open(read, { ...hello, device: read.device.id });
      await manager.open(act, { ...hello, device: act.device.id });
      const deadline = Date.now() + 15000;
      while (
        (!readMessages.some((m) => m.t === "view.tree" && m.view === "evil:probe") ||
          !actMessages.some((m) => m.t === "view.tree" && m.view === "evil:probe")) && Date.now() < deadline
      ) await delay(25);
      const readTree = readMessages.find((m) => m.t === "view.tree" && m.view === "evil:probe");
      const actTree = actMessages.find((m) => m.t === "view.tree" && m.view === "evil:probe");
      assert(
        readTree && readTree.t === "view.tree" && actTree && actTree.t === "view.tree",
        "both devices must receive the real modhost tree",
      );
      const readHandler = readTree.tree.on?.click;
      const actHandler = actTree.tree.on?.click;
      assert(typeof readHandler === "number" && typeof actHandler === "number", "probe click handler missing");
      const click = {
        t: "event" as const,
        kind: "click" as const,
        view: "evil:probe",
        data: {
          click_count: 1,
          modifiers: { shift: false, control: false, alt: false, platform: false, function: false },
        },
      };
      await manager.message(read, { ...click, id: 1, handler: readHandler });
      await manager.message(act, { ...click, id: 2, handler: actHandler });
      const tokenDeadline = Date.now() + 10000;
      while (calls.filter((c) => c.marker === "capture-token").length < 2 && Date.now() < tokenDeadline) {
        await delay(25);
      }
      const captures = calls.filter((c) => c.marker === "capture-token");
      const actToken = captures.find((c) => c.origin?.scope === "act")?.token;
      assert(typeof actToken === "string", "act event did not carry a capability");
      assert(actToken !== "sess-act", "the event must not expose the raw act session id as its capability");
      supervisor.create("thief:probe", { runtime, replay: actToken });
      const replayDeadline = Date.now() + 35000;
      while (
        (!calls.some((c) => c.marker === "foreign-token") ||
          calls.filter((c) => c.marker === "expired-token").length < 2) && Date.now() < replayDeadline
      ) await delay(25);
      for (const marker of ["raw-act", "foreign-token", "expired-token"]) {
        const matching = calls.filter((c) => c.marker === marker);
        assert(matching.length > 0, `${marker}: forged RPC did not reach policy as a downgraded request`);
        for (const call of matching) assertEquals(call.origin?.scope, "read", `${marker} gained act scope`);
      }
      assertEquals(passthroughs, 0, "forged or replayed origin reached act-only passthrough");
      assert(
        logs.some((line) => line.includes("origin downgraded")) ||
          readMessages.some((m) => m.t === "toast" && m.title.includes("read-only")),
        "refusal was not reported",
      );
    } finally {
      manager.stop();
      await supervisor.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
