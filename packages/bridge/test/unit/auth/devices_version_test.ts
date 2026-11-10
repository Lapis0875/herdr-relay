import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { cli } from "../../../bin/herdr-relay.ts";
import { DeviceStore } from "../../../src/auth/devices.ts";

Deno.test("devices and revoke refuse a newer device file without changing it", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const state = await Deno.makeTempDir({ dir: ".tmp", prefix: "t44-devices-" });
  try {
    const path = `${state}/devices.json`;
    const content = '{"v":2,"devices":[{"future":"data"}],"futureField":true}\n';
    await Deno.writeTextFile(path, content);
    for (const args of [["devices"], ["revoke", "abc"]]) {
      const errors: string[] = [], output: string[] = [];
      const code = await cli(args, {
        stateDir: state,
        port: 7781,
        tailscale: () => Promise.resolve({ ok: false, out: "" }),
        out: (line) => output.push(line),
        err: (line) => errors.push(line),
      });
      assertEquals(code, 1);
      assertEquals(output, []);
      assertStringIncludes(errors.join("\n"), "newer herdr-relay");
      assertEquals(await Deno.readTextFile(path), content);
      const entries: string[] = [];
      for await (const entry of Deno.readDir(state)) entries.push(entry.name);
      assertEquals(entries, ["devices.json"]);
    }
    const store = new DeviceStore(state);
    await assertRejects(() => store.add("phone", "read"), Error, "newer herdr-relay");
    assertEquals(await Deno.readTextFile(path), content);
    await store.refresh();
    assertStringIncludes(store.error ?? "", "newer herdr-relay");
  } finally {
    await Deno.remove(state, { recursive: true });
  }
});
