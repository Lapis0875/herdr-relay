import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { join, resolve } from "@std/path";
import { type HostExit, HostSupervisor } from "../../src/hosts/supervisor.ts";
import { fixtureState } from "../fixtures/state.ts";

for (
  const [row, attack] of [
    ["S18 authentication flood", "flood"],
    ["S27 self-kill", "self-kill"],
    ["S27 Deno.exit", "exit"],
    ["S28 watchdog", "hog"],
    ["S29 heap exhaustion", "oom"],
  ] as const
) {
  Deno.test({
    name: `${row}: supervisor restarts hostile folder and leaves another host running`,
    ignore: Deno.build.os !== "darwin",
    async fn() {
      await Deno.mkdir(".tmp", { recursive: true });
      const dir = await Deno.makeTempDir({ dir: resolve(".tmp"), prefix: "availability-" });
      const app = join(dir, "app");
      const run = join(dir, "run");
      for (const folder of ["evil", "safe"]) {
        const mod = join(app, "mods", folder);
        await Deno.mkdir(mod, { recursive: true });
        await Deno.copyFile("fixtures/probe-mods/evil/main.js", join(mod, "main.js"));
      }
      await Deno.mkdir(run);
      const state = fixtureState("fixtures/generic-home", dir, "main");
      const exits: HostExit[] = [];
      let hogStarted = 0;
      let hogExited = 0;
      let safeRenders = 0;
      const supervisor = await HostSupervisor.create({
        appHome: app,
        modhost: "packages/modhost",
        run,
        stateDir: run,
        stateFor: (folder) => ({ ...state, folder }),
        limits: { backoffMs: [0] },
        log: (line) => {
          if (line.includes("HOG_STARTED") && hogStarted === 0) hogStarted = Date.now();
        },
        handlers: {
          tree: (host) => {
            if (host.folder === "safe") safeRenders++;
          },
          exited: (host, exit) => {
            if (host.folder === "evil") {
              exits.push(exit);
              if (hogExited === 0) hogExited = Date.now();
            }
          },
        },
      });
      try {
        supervisor.create("safe:probe", { attack: "S24" });
        const healthyDeadline = Date.now() + 10000;
        while (safeRenders === 0 && Date.now() < healthyDeadline) await delay(25);
        assert(safeRenders > 0, "control host did not render");
        const healthyPid = supervisor.info("safe")?.pid;
        assert(healthyPid !== null && healthyPid !== undefined);
        supervisor.create("evil:probe", { attack, ctlPort: supervisor.port });
        const startDeadline = Date.now() + 10000;
        while ((supervisor.info("evil")?.generation ?? 0) < 1 && Date.now() < startDeadline) await delay(10);
        assert((supervisor.info("evil")?.generation ?? 0) >= 1, `${row}: no host started`);
        if (attack === "hog") {
          while (hogStarted === 0 && Date.now() < startDeadline) await delay(5);
          assert(hogStarted !== 0, "hog did not enter its busy loop");
          const before = safeRenders;
          assert(supervisor.render("safe:probe"), "control host cannot accept a render");
          const renderDeadline = Date.now() + 1000;
          while (safeRenders === before && Date.now() < renderDeadline) await delay(5);
          assert(safeRenders > before, "control host did not render while the other host was busy");
        }
        const deadline = (attack === "hog" ? hogStarted : Date.now()) +
          (attack === "hog" ? 7000 : attack === "oom" ? 30000 : 10000);
        while (exits.length === 0 && Date.now() < deadline) await delay(5);
        assert(exits.length > 0, `${row}: host was not killed/exited within its deadline`);
        if (attack === "hog") {
          assert(hogExited - hogStarted <= 7000, `hog exit took ${hogExited - hogStarted} ms`);
          assertEquals(exits[0].reason, "no pong for 6 s");
        }
        const restartDeadline = Date.now() + 5000;
        while ((supervisor.info("evil")?.generation ?? 0) < 2 && Date.now() < restartDeadline) await delay(10);
        assert((supervisor.info("evil")?.generation ?? 0) >= 2, `${row}: no restart by deadline`);
        if (attack === "exit") assertEquals(exits[0].code, 7);
        if (attack === "oom") assertEquals(exits[0].code, 133);
        assertEquals(supervisor.info("safe")?.pid, healthyPid);
        assertEquals(supervisor.info("safe")?.status.state, "running");
      } finally {
        await supervisor.stop();
        await Deno.remove(dir, { recursive: true });
      }
    },
  });
}
