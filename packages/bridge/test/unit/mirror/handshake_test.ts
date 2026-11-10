import { assertEquals, assertStringIncludes } from "@std/assert";
import { LOCAL_DEVICE } from "../../../src/auth/devices.ts";
import { MirrorEndpoint } from "../../../src/mirror.ts";

Deno.test("mirror POST handshake reports old versions and notifies once per distinct version", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const root = await Deno.makeTempDir({ dir: ".tmp", prefix: "t44-mirror-" });
  const state = `${root}/state`, app = `${root}/app`;
  await Deno.mkdir(state);
  await Deno.mkdir(`${app}/data/herdr-relay`, { recursive: true });
  const notices: string[] = [];
  const mirror = await MirrorEndpoint.start({
    appHome: app,
    stateDir: state,
    port: 7781,
    bundledMod: "1.0.0",
    sink: { mirror: () => {} },
    log: () => {},
    onOutdated: (text) => notices.push(text),
  });
  try {
    const route = mirror.route();
    const context = { path: "/mirror", via: "local" as const, login: null, device: LOCAL_DEVICE };
    const post = async (body: unknown) => {
      const response = await route.handle(
        new Request("http://127.0.0.1/mirror", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        context,
      );
      return { status: response.status, body: await response.json() };
    };
    let result = await post({ relayMod: "0.1.0" });
    assertEquals(result.status, 200);
    assertEquals(result.body.outdated, true);
    assertEquals(result.body.bundledMod, "1.0.0");
    assertEquals(result.body.changed, true);
    assertEquals(notices.length, 1);
    assertStringIncludes(notices[0], "0.1.0");
    result = await post({ relayMod: "0.1.0" });
    assertEquals(result.body.changed, false);
    assertEquals(result.body.outdated, true);
    assertEquals(notices.length, 1);
    result = await post({ relayMod: "0.1.0", theme: { bg: "#000" } });
    assertEquals(result.body.changed, true);
    assertEquals(notices.length, 1);
    result = await post({ relayMod: "0.2.0" });
    assertEquals(result.body.outdated, true);
    assertEquals(notices.length, 2);
    assertStringIncludes(notices[1], "0.2.0");
    result = await post({ relayMod: "1.0.0" });
    assertEquals(result.body.outdated, false);
    assertEquals(notices.length, 2);
    const status = await route.handle(new Request("http://127.0.0.1/mirror"), context);
    const data = await status.json();
    assertEquals(data.bundledMod, "1.0.0");
    assertEquals(data.outdated, false);
    result = await post({ relayMod: "0.1.0" });
    assertEquals(result.body.outdated, true);
    assertEquals(notices.length, 2);
    const current = await route.handle(new Request("http://127.0.0.1/mirror"), context);
    assertEquals((await current.json()).outdated, true);
  } finally {
    await mirror.close();
    await Deno.remove(root, { recursive: true });
  }
});
