import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ProfileSet } from "../../../src/policy/profiles.ts";
import { parseOverlaySpec } from "../../../src/views/overlays.ts";

Deno.test("host-only overlay is refused with a device-visible Herdr window reason", async () => {
  const profiles = await ProfileSet.load({ log: () => {} });
  const placement = (folder: string) => profiles.profileFor(folder).overlay ?? "device";
  const refused = parseOverlaySpec({ mod: "machine-add" }, placement);
  assertEquals(typeof refused, "string");
  assertStringIncludes(refused as string, "Herdr window");
  const allowed = parseOverlaySpec({ mod: "picker" }, placement);
  assert(typeof allowed !== "string");
  assertEquals(allowed.mod, "picker");
});
