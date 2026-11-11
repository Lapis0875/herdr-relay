/**
 * Scroll requests (`scrollTo`, protocol `ScrollRequest`) on mounted elements: a virtual list (`widgets/VirtualList.tsx`)
 * brings in rows it has not mounted from its row offsets, and every element carries out each request once per `gen` +
 * `seq` — `seq` starts again in each mod host process, which `gen` names, so the same number from a restarted host is
 * a new request while the same `gen` + `seq` again is not. The fake document has no layout: the list's scrollport
 * and content sizes are set by the test, and only `scrollTop` and the mounted rows are observed.
 */

import { assertEquals } from "@std/assert";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ElementNode, ScrollRequest } from "@herdr-relay/protocol";
import { useScrollTo } from "../src/render/scroll.ts";
import { TreeView } from "../src/render/view.tsx";
import { provideWidgetRenderer } from "../src/render/widgets.tsx";
import { VirtualList } from "../src/widgets/VirtualList.tsx";
import { elementsWithClass, type FakeElement, installDom, quietly } from "./fake_dom.ts";

const { doc } = installDom();
provideWidgetRenderer("vlist", VirtualList);

/** 120 recorded rows of 20 px (2400 px) out of `count`, in a 200 px tall list. */
const ROWS = 120;
function list(scrollTo?: ScrollRequest, count = ROWS): ElementNode {
  return {
    k: "el",
    tag: "v_virtual_list",
    id: "rows",
    style: { width: 240, height: 200 },
    attrs: { track_scroll: "VirtualListScrollHandle:1" },
    ...(scrollTo ? { scrollTo } : {}),
    children: Array.from({ length: ROWS }, (_, i) => ({ k: "text", style: {}, text: `row ${i}` })),
    widget: {
      type: "vlist",
      state: "rows",
      props: { count, keys: Array.from({ length: ROWS }, (_, i) => `r${i}`), sizes: 20 },
    },
  };
}

/** A mounted list laid out as a 200 px scrollport over 2400 px of rows. */
async function mount(count = ROWS): Promise<{ root: Root; container: FakeElement; box: FakeElement }> {
  const container = doc.body.appendChild(doc.createElement("div"));
  const root = createRoot(container as unknown as Element);
  await show(root, list(undefined, count));
  const box = elementsWithClass(container, "w-vlist")[0];
  box.clientHeight = 200;
  box.scrollHeight = ROWS * 20;
  return { root, container, box };
}

async function show(root: Root, tree: ElementNode): Promise<void> {
  await act(() => root.render(<TreeView view="test:list" tree={tree} send={null} typing={false} />));
}

/** The first and last mounted row. */
function mounted(container: FakeElement): [number, number] {
  const rows = elementsWithClass(container, "w-vlist__row").map((r) => Number(r.getAttribute("data-index")));
  return [Math.min(...rows), Math.max(...rows)];
}

async function unmount(root: Root, container: FakeElement): Promise<void> {
  await act(() => root.unmount());
  container.parentNode?.removeChild(container);
}

Deno.test("virtual list: a request brings in unmounted rows from the row offsets", async () => {
  await quietly(async () => {
    const { root, container, box } = await mount(150);
    assertEquals(mounted(container), [0, 6]);

    // Row 30 (600–620 px) is below the view: its far edge meets the view's (the smallest scroll), and the rows
    // around it are mounted in the same commit.
    await show(root, list({ seq: 1, index: 30, gen: "a.1" }, 150));
    assertEquals(box.scrollTop, 420);
    assertEquals(mounted(container), [15, 37]);

    // A row already in view stays put.
    await show(root, list({ seq: 2, index: 25, gen: "a.1" }, 150));
    assertEquals(box.scrollTop, 420);

    // `center`: row 5 (100–120 px) in the middle of the view.
    await show(root, list({ seq: 3, index: 5, strategy: "center", gen: "a.1" }, 150));
    assertEquals(box.scrollTop, 10);
    assertEquals(mounted(container), [0, 16]);

    // Above the view: its near edge meets the view's.
    box.scrollTop = 1000;
    await show(root, list({ seq: 4, index: 40, gen: "a.1" }, 150));
    assertEquals(box.scrollTop, 800);

    // `bottom`: the end (scrollHeight − clientHeight), with the last rows mounted.
    await show(root, list({ seq: 5, bottom: true, gen: "a.1" }, 150));
    assertEquals(box.scrollTop, 2200);
    assertEquals(mounted(container), [104, 119]);

    // A row the host did not record (120 ≤ index < count) scrolls to the end, where the list notes the rest.
    box.scrollTop = 0;
    await show(root, list({ seq: 6, index: 130, gen: "a.1" }, 150));
    assertEquals(box.scrollTop, 2200);

    // An index at or past `count` does nothing.
    box.scrollTop = 0;
    await show(root, list({ seq: 7, index: 150, gen: "a.1" }, 150));
    assertEquals(box.scrollTop, 0);

    await unmount(root, container);
  });
});

Deno.test("virtual list: each request runs once per gen + seq, the same seq of another host process again", async () => {
  await quietly(async () => {
    const { root, container, box } = await mount();
    await show(root, list({ seq: 1, index: 30, gen: "a.1" }));
    assertEquals(box.scrollTop, 420);

    // The person scrolls away; the next tree repeats the same request (every tree keeps the latest): it stays.
    box.scrollTop = 0;
    await show(root, list({ seq: 1, index: 30, gen: "a.1" }));
    assertEquals(box.scrollTop, 0);

    // The host restarted (generation 2): its first request is seq 1 again, and it is carried out.
    await show(root, list({ seq: 1, index: 30, gen: "a.2" }));
    assertEquals(box.scrollTop, 420);

    // The bridge restarted (another run, generation 1 again) while the view stayed mounted: carried out too.
    box.scrollTop = 0;
    await show(root, list({ seq: 1, index: 30, gen: "b.1" }));
    assertEquals(box.scrollTop, 420);

    box.scrollTop = 0;
    await show(root, list({ seq: 1, index: 30, gen: "b.1" }));
    assertEquals(box.scrollTop, 0);

    await unmount(root, container);
  });
});

Deno.test("plain element: the same seq from two host processes is carried out twice, a repeat once", async () => {
  const container = doc.body.appendChild(doc.createElement("div"));
  // A 100 px scrollport whose only child sits 110–120 px down: each reveal scrolls by 20 px.
  const child = {
    getClientRects: () => [1],
    getBoundingClientRect: () => ({ top: 110, bottom: 120, left: 0, right: 10 }),
  };
  const box = {
    clientTop: 0,
    clientLeft: 0,
    clientWidth: 100,
    clientHeight: 100,
    scrollTop: 0,
    scrollLeft: 0,
    getBoundingClientRect: () => ({ top: 0, left: 0 }),
    children: { item: (index: number) => (index === 0 ? child : null) },
  };
  const ref = { current: box as unknown as HTMLElement };
  function Strip({ request }: { request: ScrollRequest }) {
    const node: ElementNode = {
      k: "el",
      tag: "div",
      style: { overflowY: "auto" },
      children: [{ k: "text", style: {}, text: "item" }],
      scrollTo: request,
    };
    useScrollTo(ref, node, 0);
    return null;
  }
  const root = createRoot(container as unknown as Element);
  await quietly(async () => {
    const shown = (request: ScrollRequest) => act(() => root.render(createElement(Strip, { request })));
    await shown({ seq: 1, index: 0, gen: "a.1" });
    assertEquals(box.scrollTop, 20);
    await shown({ seq: 1, index: 0, gen: "a.1" });
    assertEquals(box.scrollTop, 20);
    await shown({ seq: 1, index: 0, gen: "a.2" });
    assertEquals(box.scrollTop, 40);
    await shown({ seq: 1, index: 0, gen: "a.2" });
    assertEquals(box.scrollTop, 40);
    await act(() => root.unmount());
  });
  container.parentNode?.removeChild(container);
});
