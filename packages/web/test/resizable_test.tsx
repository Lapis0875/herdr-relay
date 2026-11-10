/**
 * Mod splits (`widgets/Resizable.tsx`) mounted with react-dom on a minimal in-memory document (`fake_dom.ts`), so one
 * mounted group can be re-rendered: sizes kept on this device are found under the layout the ScreenGraph shows now
 * (not the one the connection started with), and a mod narrowing a panel's `size_range` redraws the same group
 * within it. There is no layout here, so the dividers report the panels' own sizes and ranges.
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BridgeHello, ElementNode, ElNode, JsonValue } from "@herdr-relay/protocol";
import { blankState, getState, initStore, setState } from "../src/app/store.ts";
import { TreeView } from "../src/render/view.tsx";
import "../src/widgets/mod.ts";
import { elementsWithClass, type FakeElement, installDom, quietly } from "./fake_dom.ts";

const { doc, storage } = installDom();

// --- the group: sidebar 220 (160–320) | editor (flexible) | inspector 120 (80–300) --------------------------------

const VIEW = "test:view";
const panel = (size?: number, range?: number[]): ElNode => ({
  k: "el",
  tag: "resizable_panel",
  style: size === undefined ? {} : { width: size, height: size },
  ...(range ? { attrs: { size_range: range as JsonValue } } : {}),
  children: [{ k: "el", tag: "div", style: { width: "100%", height: "100%" } }],
});
const group = (sidebarMax: number): ElementNode => ({
  k: "el",
  tag: "h_resizable",
  id: "workspace",
  style: { width: "100%", height: "100%" },
  widget: { type: "resizable", state: "workspace", props: {} },
  children: [panel(220, [160, sidebarMax]), panel(), panel(120, [80, 300])],
});

const keyFor = (layout: string) => `herdr-relay:split:${layout}:${VIEW}#workspace`;
const keep = (layout: string, sizes: (number | null)[]) =>
  storage.setItem(keyFor(layout), JSON.stringify({ sizes, used: 1 }));

const hello: BridgeHello = JSON.parse(await Deno.readTextFile("packages/protocol/samples/bridge/hello.json"));

/** A fresh store as a connected tablet has it (`hello` + its graph), a fresh storage, and an empty mount point. */
function setup(): { root: Root; container: FakeElement } {
  storage.clear();
  initStore(blankState("tablet-landscape"));
  setState({ hello, graph: hello.screens });
  const container = doc.body.appendChild(doc.createElement("div"));
  return { root: createRoot(container as unknown as Element), container };
}

async function render(root: Root, tree: ElementNode): Promise<void> {
  await act(() => root.render(<TreeView view={VIEW} tree={tree} send={null} typing={false} />));
}

const flexes = (container: FakeElement) => elementsWithClass(container, "w-resizable__panel").map((p) => p.style.flex);

Deno.test("resizable: kept sizes follow the layout the ScreenGraph shows, not hello.layout", async () => {
  await quietly(async () => {
    const { root, container } = setup();
    const started = hello.layout.name;
    // The Mac switched layouts without a reconnect: only `patch.screens` names the new one.
    setState({ graph: { ...hello.screens, layout: "switched" } });
    keep("switched", [250, null, 140]);
    keep(started, [300, null, 100]);

    await render(root, group(320));
    assertEquals(flexes(container), ["0 0 250px", "1 1 0", "0 0 140px"]);
    const sidebar = elementsWithClass(container, "w-resizable__panel")[0];
    // Restoring marked the shown layout's entry as used; the other layout's entry is untouched.
    assert(JSON.parse(storage.getItem(keyFor("switched"))!).used > 1);
    assertEquals(JSON.parse(storage.getItem(keyFor(started))!).used, 1);

    // Switching back on the same mounted group restores that layout's sizes.
    await act(() => setState({ graph: { ...getState().graph!, layout: started } }));
    assertEquals(flexes(container), ["0 0 300px", "1 1 0", "0 0 100px"]);
    assertStrictEquals(elementsWithClass(container, "w-resizable__panel")[0], sidebar);

    await act(() => root.unmount());
  });
});

Deno.test("resizable: a narrower size_range redraws the same mounted group within it, other sizes kept", async () => {
  await quietly(async () => {
    const { root, container } = setup();
    keep(hello.screens.layout, [300, null, 140]);

    await render(root, group(320));
    assertEquals(flexes(container), ["0 0 300px", "1 1 0", "0 0 140px"]);
    const sidebar = elementsWithClass(container, "w-resizable__panel")[0];
    const divider = () => elementsWithClass(container, "w-resizable__handle")[0];
    assertEquals(divider().getAttribute("aria-valuemax"), "320");

    // The mod re-renders the same split with the sidebar's maximum at 200.
    await render(root, group(200));
    assertStrictEquals(elementsWithClass(container, "w-resizable__panel")[0], sidebar);
    assertEquals(flexes(container), ["0 0 200px", "1 1 0", "0 0 140px"]);
    assertEquals(divider().getAttribute("aria-valuenow"), "200");
    assertEquals(divider().getAttribute("aria-valuemax"), "200");

    // The person's choice is still kept: a wider range draws it again, as a reload would.
    assertEquals(JSON.parse(storage.getItem(keyFor(hello.screens.layout))!).sizes, [300, null, 140]);
    await render(root, group(400));
    assertEquals(flexes(container), ["0 0 300px", "1 1 0", "0 0 140px"]);

    await act(() => root.unmount());
  });
});
