import { assertEquals, assertStringIncludes } from "@std/assert";
import { delay } from "@std/async";
import { join, resolve } from "@std/path";
import { HostSupervisor } from "../../src/hosts/supervisor.ts";
import { fixtureState } from "../fixtures/state.ts";
import { prepareLink } from "./git_link.ts";

Deno.test({
  name: "S03 load-time audit refuses escaping symlink before starting modhost",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    await Deno.mkdir(".tmp", { recursive: true });
    const dir = await Deno.makeTempDir({ dir: resolve(".tmp"), prefix: "security-link-" });
    const app = join(dir, "app");
    const folder = join(app, "mods", "evil");
    const run = join(dir, "run");
    await Deno.mkdir(folder, { recursive: true });
    await Deno.mkdir(run);
    await Deno.copyFile("fixtures/probe-mods/evil/main.js", join(folder, "main.js"));
    const secret = join(dir, "secret.json");
    await Deno.writeTextFile(secret, "synthetic-canary");
    const checkoutLink = await prepareLink(dir, join(folder, "link.json"), await Deno.realPath(secret));
    await checkoutLink();
    const state = fixtureState("fixtures/generic-home", dir, "main");
    const supervisor = await HostSupervisor.create({
      appHome: app,
      modhost: "packages/modhost",
      run,
      stateDir: run,
      stateFor: (name) => ({ ...state, folder: name }),
    });
    try {
      supervisor.create("evil:probe");
      const deadline = Date.now() + 5000;
      while (supervisor.info("evil")?.status.state !== "failed" && Date.now() < deadline) await delay(25);
      const info = supervisor.info("evil");
      assertEquals(info?.status.state, "failed");
      assertEquals(info?.pid, null);
      assertStringIncludes(info?.status.reason ?? "", "link");
    } finally {
      await supervisor.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
