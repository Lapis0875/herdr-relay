import { assertEquals } from "@std/assert";
import { loadConfig } from "../../src/config.ts";
import { EXIT_NO_SANDBOX, runBridge } from "../../src/main.ts";
import { resolvePlatform } from "../../src/platform.ts";

Deno.test("S35 unavailable sandbox exits 3 before state creation; insecure mode disables pairing", async () => {
  const platform = resolvePlatform({ os: "darwin", env: () => undefined, isFile: () => false, mayRun: () => false });
  const unavailable = { ...platform.sandbox!, available: () => Promise.resolve(false) };
  const fake = { ...platform, sandbox: unavailable };
  const values: Record<string, string> = { HOME: "/synthetic-security-home", TMPDIR: "/synthetic-security-tmp" };
  const env = { get: (key: string) => values[key] };
  assertEquals(await runBridge({ platform: () => fake, env }), EXIT_NO_SANDBOX);
  assertEquals(loadConfig(fake, env).pairing, true);
  values.HERDR_RELAY_DEV = "insecure-no-sandbox";
  assertEquals(loadConfig(fake, env).pairing, false);
});
