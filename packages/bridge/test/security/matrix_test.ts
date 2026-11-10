import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { join, resolve } from "@std/path";
import { HostSupervisor } from "../../src/hosts/supervisor.ts";
import { fixtureState } from "../fixtures/state.ts";
import { prepareLink } from "./git_link.ts";

// Unit-owned rows: S04, S06, S08, S09, S11–S16, S30, S31 (T23),
// S33 (T25), S34 (T26). S10 also requires the separate bridge flags test.
// S32 has a separate production-flags subprocess test.
const rows = [
  ["S01", "Deno flags: state file"],
  ["S02", "Deno flags: dynamic import of secret module"],
  ["S05", "Deno flags: other app-home file"],
  ["S07", "Deno flags and Seatbelt: subprocess"],
  ["S17", "Deno flags: non-control loopback port"],
  ["S18", "control authentication: tokenless hello"],
  ["S19", "control attribution: foreign copy RPC and emit"],
  ["S20", "Deno flags: environment"],
  ["S21", "Deno flags: remote, npm and jsr imports"],
  ["S22", "Deno flags: permission escalation"],
  ["S23", "runtime hardening: shared web storage"],
  ["S24", "runtime hardening: Deno internals"],
  ["S25", "process separation: stdout is never interpreted as control traffic"],
  ["S26", "Deno flags: signal parent"],
  ["S36", "Seatbelt: symlink planted after host starts"],
] as const;

for (const [attack, layer] of rows) {
  Deno.test({
    name: `${attack} ${layer}`,
    ignore: Deno.build.os !== "darwin",
    async fn() {
      await Deno.mkdir(".tmp", { recursive: true });
      const dir = await Deno.makeTempDir({ dir: resolve(".tmp"), prefix: "security-" });
      const app = join(dir, "app");
      const mod = join(app, "mods", "evil");
      const run = join(dir, "run");
      await Deno.mkdir(mod, { recursive: true });
      await Deno.mkdir(run);
      await Deno.copyFile("fixtures/probe-mods/evil/main.js", join(mod, "main.js"));
      await Deno.copyFile("fixtures/probe-mods/evil/static.js", join(mod, "static.js"));
      const secret = join(dir, "devices.json");
      const secretModule = join(dir, "secret.js");
      const settings = join(app, "settings.json");
      const otherDir = join(app, "mods", "other");
      await Deno.mkdir(otherDir);
      const otherMod = join(otherDir, "ui.js");
      await Deno.writeTextFile(otherMod, "synthetic-other-mod");
      await Deno.writeTextFile(secret, "synthetic-canary");
      await Deno.writeTextFile(secretModule, "export default 'synthetic-canary';");
      await Deno.writeTextFile(settings, "synthetic-settings");
      const link = join(await Deno.realPath(mod), "late-link.json");
      const checkoutLink = attack === "S36" ? await prepareLink(dir, link, await Deno.realPath(secret)) : null;
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      let latest = "";
      let emitted = false;
      let rpc = false;
      const logs: string[] = [];
      const state = fixtureState("fixtures/generic-home", dir, "main");
      const supervisor = await HostSupervisor.create({
        appHome: app,
        modhost: "packages/modhost",
        run,
        stateDir: run,
        stateFor: (folder) => ({ ...state, folder }),
        log: (line) => logs.push(line),
        handlers: {
          tree: (_host, message) => {
            latest = JSON.stringify(message.tree);
          },
          emit: () => {
            emitted = true;
          },
          rpc: () => {
            rpc = true;
            return null;
          },
        },
      });
      try {
        supervisor.create("evil:probe", {
          attack,
          link,
          runtime: await Deno.realPath("packages/modhost/src/runtime.js"),
          secret: await Deno.realPath(secret),
          secretModule: await Deno.realPath(secretModule),
          settings: await Deno.realPath(settings),
          otherMod: await Deno.realPath(otherMod),
          port: (listener.addr as Deno.NetAddr).port,
          ctlPort: supervisor.port,
        });
        if (attack === "S36") {
          const startDeadline = Date.now() + 10000;
          while (supervisor.info("evil")?.status.state !== "running" && Date.now() < startDeadline) await delay(10);
          assertEquals(supervisor.info("evil")?.status.state, "running");
          assert(checkoutLink);
          await checkoutLink();
        }
        const deadline = Date.now() + 10000;
        while (!latest.includes("blocked") && !latest.includes("allowed") && Date.now() < deadline) await delay(25);
        assert(latest, `${attack}: no tree received`);
        assertEquals(latest.includes("blocked"), true, `${attack}: ${latest}`);
        if (attack === "S25") assertEquals(emitted, false, "forged stdout reached an emit handler");
        if (attack === "S19") {
          assert(logs.some((line) => line.includes("forged-rpc-ignored")));
          assert(logs.some((line) => line.includes("forged-emit-ignored")));
          assert(logs.some((line) => line.includes("forged-tree-ignored")));
          assertEquals(rpc, false);
          assertEquals(emitted, false);
        }
        if (attack === "S36") {
          supervisor.restart("evil");
          const restartDeadline = Date.now() + 10000;
          while (supervisor.info("evil")?.status.state !== "failed" && Date.now() < restartDeadline) await delay(25);
          assertEquals(supervisor.info("evil")?.status.state, "failed");
        }
      } finally {
        listener.close();
        await supervisor.stop();
        await Deno.remove(dir, { recursive: true });
      }
    },
  });
}
