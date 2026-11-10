import { assert, assertEquals } from "@std/assert";
import { HostStateSchema, is } from "@herdr-relay/protocol";
import { fixtureState } from "../fixtures/state.ts";

Deno.test("generic fixture state is valid for each shipped layout", () => {
  for (const layout of ["main", "terminals", "win98"]) {
    const state = fixtureState("fixtures/generic-home", ".tmp/fixture-home", layout);
    assert(is(HostStateSchema, state), `${layout}: invalid HostState`);
    assertEquals(state.layouts, [layout]);
    assertEquals(state.focused?.pane, state.panes[0].pane);
    assertEquals(state.focused?.terminal, state.terminals[0].address);
    assertEquals(state.spaces[0].folder, ".tmp/fixture-home/project");
  }
});
