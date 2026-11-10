import { assertEquals } from "@std/assert";
import { type DeviceClass, HOME_ROUTE, type LayoutNode, recomposeTree } from "@herdr-relay/protocol";
import { leadingBarOf } from "../src/app/nav.ts";

const layouts: Record<string, string> = {
  main: "fixtures/generic-home/layouts/main.json",
  terminals: "fixtures/generic-home/layouts/terminals.json",
  win98: "fixtures/generic-home/layouts/win98.json",
  "lstack-herdr": "fixtures/layouts/lstack-herdr.json",
};

/** The bar the home route's shell button leads, as the navigator computes it. */
function lead(name: string, device: DeviceClass): string | null {
  const tree = JSON.parse(Deno.readTextFileSync(layouts[name])) as LayoutNode;
  const home = recomposeTree(name, tree, device).routes.find((r) => r.path === HOME_ROUTE);
  if (!home) throw new Error(`${name} has no home route on ${device}`);
  return leadingBarOf(home.screen, device);
}

Deno.test("phone: the shell button leads the top bar instead of floating over its first item", () => {
  assertEquals(lead("lstack-herdr", "phone"), "topbar");
  assertEquals(lead("main", "phone"), "tabs");
  assertEquals(lead("terminals", "phone"), "tabs");
  // The screen starts with the desktop link, not a bar: the button floats.
  assertEquals(lead("win98", "phone"), null);
});

Deno.test("tablets: only a row bar takes the shell button", () => {
  for (const device of ["tablet-portrait", "tablet-landscape"] as const) {
    assertEquals(lead("lstack-herdr", device), "topbar");
    assertEquals(lead("main", device), null);
  }
});
