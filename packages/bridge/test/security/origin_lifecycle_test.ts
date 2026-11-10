import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { join, resolve } from "@std/path";
import type { BridgeMessage, LayoutNode, PolicyLogRecord, Scope } from "@herdr-relay/protocol";
import { HostSupervisor } from "../../src/hosts/supervisor.ts";
import type { SessionConnection } from "../../src/server/connection.ts";
import type { HerdrData, ResolvedOrigin } from "../../src/views/data.ts";
import { REVOKED_CLOSE, ViewManager } from "../../src/views/manager.ts";
import { fixtureState } from "../fixtures/state.ts";

Deno.test({
  name: "S19 origin tokens are revoked on disconnect, resume and device revocation",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    await Deno.mkdir(".tmp", { recursive: true });
    const root = await Deno.makeTempDir({ dir: resolve(".tmp"), prefix: "origin-lifecycle-" });
    const app = join(root, "app");
    const run = join(root, "run");
    await Deno.mkdir(join(app, "mods", "probe"), { recursive: true });
    await Deno.mkdir(run);
    await Deno.copyFile("fixtures/probe-mods/origin-replay/main.js", join(app, "mods", "probe", "main.js"));
    const runtime = await Deno.realPath("packages/modhost/src/runtime.js");
    const state = fixtureState("fixtures/generic-home", root, "main");
    const tree: LayoutNode = {
      id: "root",
      type: "row",
      children: [
        { id: "probe", type: "block", content: { mod: "probe", props: { runtime } } },
      ],
    };
    const calls: { marker: string; at: number; origin: ResolvedOrigin | null }[] = [];
    const logs: string[] = [];
    const policy: PolicyLogRecord[] = [];
    const data: HerdrData = {
      layout: () => ({ layout: { name: "origin-lifecycle", tree }, clicks: null }),
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
      rpc: (_host, message, origin) => {
        calls.push({ marker: String(message.args[0]), at: performance.now(), origin });
        return Promise.resolve(null);
      },
    };
    let supervisor!: HostSupervisor;
    const manager = await ViewManager.start({
      data,
      roots: [],
      log: (line) => logs.push(line),
      policyLog: (record) => policy.push(record),
      hosts: async (wiring) => {
        supervisor = await HostSupervisor.create({
          appHome: app,
          modhost: "packages/modhost",
          run,
          stateDir: run,
          stateFor: wiring.stateFor,
          handlers: wiring.handlers,
          log: () => {},
        });
        return supervisor;
      },
    });
    class Conn implements SessionConnection {
      readonly via = "local" as const;
      readonly bufferedAmount = 0;
      readonly messages: BridgeMessage[] = [];
      closed: [number, string] | null = null;
      constructor(readonly id: string, readonly device: { id: string; name: string; scope: Scope }) {}
      send(message: BridgeMessage) {
        this.messages.push(structuredClone(message));
        return true;
      }
      sendBinary() {
        return true;
      }
      close(code = 1000, reason = "") {
        this.closed = [code, reason];
      }
      get seq() {
        let seq = 0;
        for (const message of this.messages) if ("seq" in message) seq = message.seq;
        return seq;
      }
    }
    async function waitFor<T>(find: () => T | undefined, label: string): Promise<T> {
      const deadline = performance.now() + 15000;
      while (performance.now() < deadline) {
        const value = find();
        if (value !== undefined) return value;
        await delay(20);
      }
      throw new Error(`timed out waiting for ${label}`);
    }
    async function after(marker: string, since: number): Promise<ResolvedOrigin | null> {
      return (await waitFor(() => calls.find((call) => call.marker === marker && call.at > since), marker)).origin;
    }
    let requestId = 1;
    async function click(conn: Conn): Promise<void> {
      await delay(400);
      const handler = await waitFor(() => {
        for (let i = conn.messages.length - 1; i >= 0; i--) {
          const msg = conn.messages[i];
          if (msg.t === "view.tree" && msg.view === "probe:probe") return msg.tree.on?.click;
          if (msg.t === "patch") {
            const op = (msg.views.find((view) => view.view === "probe:probe")?.ops ?? []).findLast((item) =>
              item.path === "/on/click" && (item.op === "replace" || item.op === "add")
            );
            if (op && "value" in op && typeof op.value === "number") return op.value;
          }
        }
        return undefined;
      }, `click handler for ${conn.id}`);
      await manager.message(conn, {
        t: "event",
        id: requestId++,
        view: "probe:probe",
        handler,
        kind: "click",
        data: {
          click_count: 1,
          modifiers: { shift: false, control: false, alt: false, platform: false, function: false },
        },
      });
    }
    const hello = {
      t: "hello" as const,
      v: 1 as const,
      class: "desktop" as const,
      viewport: { w: 1280, h: 800, dpr: 1 },
    };
    try {
      const first = new Conn("conn-a1", { id: "dev-act", name: "act", scope: "act" });
      await manager.open(first, { ...hello, device: first.device.id });
      await click(first);
      assertEquals((await after("capture-0", 0))?.scope, "act");
      assertEquals((await after("replay-0", performance.now()))?.connected, true);
      const seq = first.seq;
      manager.close(first, 1001, "going away");
      const disconnected = await after("replay-0", performance.now());
      assertEquals([disconnected?.scope, disconnected?.connected], ["read", false]);
      assert(manager.session(first.id), "disconnected session should remain resumable");
      const resumed = new Conn("conn-a2", first.device);
      await manager.open(resumed, { ...hello, device: resumed.device.id, session: first.id, since: seq });
      const helloResumed = resumed.messages.find((msg) => msg.t === "hello");
      assert(helloResumed?.t === "hello" && helloResumed.resumed === true);
      const old = await after("replay-0", performance.now());
      assertEquals([old?.scope, old?.connected], ["read", false]);
      if (!resumed.messages.some((msg) => msg.t === "view.tree" && msg.view === "probe:probe")) {
        resumed.messages.push(...first.messages.filter((msg) => msg.t === "view.tree"));
      }
      await click(resumed);
      const fresh = await after("capture-1", 0);
      assertEquals([fresh?.scope, fresh?.connected], ["act", true]);
      assertEquals((await after("replay-1", performance.now()))?.scope, "act");
      manager.close(resumed, REVOKED_CLOSE.code, REVOKED_CLOSE.reason);
      assertEquals(manager.session(first.id), undefined);
      const revoked = await after("replay-1", performance.now());
      assertEquals([revoked?.scope, revoked?.connected], ["read", false]);
      const replacement = new Conn("conn-a3", first.device);
      await manager.open(replacement, {
        ...hello,
        device: replacement.device.id,
        session: first.id,
        since: resumed.seq,
      });
      const replacementHello = replacement.messages.find((msg) => msg.t === "hello");
      assert(replacementHello?.t === "hello" && replacementHello.resumed !== true);
      assertEquals(replacementHello.session, replacement.id);
      const other = new Conn("conn-b", { id: "dev-b", name: "b", scope: "act" });
      await manager.open(other, { ...hello, device: other.device.id });
      await click(other);
      const captured = await waitFor(
        () => calls.find((call) => call.marker.startsWith("capture-") && call.origin?.session === other.id),
        "second device token",
      );
      assertEquals(captured.origin?.scope, "act");
      const index = captured.marker.slice("capture-".length);
      manager.revokeDevice(other.device.id);
      assertEquals(other.closed, [REVOKED_CLOSE.code, REVOKED_CLOSE.reason]);
      assertEquals(manager.session(other.id), undefined);
      manager.close(other, REVOKED_CLOSE.code, REVOKED_CLOSE.reason);
      const revokedOther = await after(`replay-${index}`, performance.now());
      assertEquals([revokedOther?.scope, revokedOther?.connected], ["read", false]);
      for (const reason of ["session not connected", "token from before the session reconnected", "unknown token"]) {
        assert(logs.some((line) => line.includes(`(${reason})`)), `missing downgrade log: ${reason}`);
        assert(
          policy.some((record) => record.rule === "origin" && record.reason?.includes(reason)),
          `missing policy record: ${reason}`,
        );
      }
    } finally {
      manager.stop();
      await supervisor.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
