import { assertEquals } from "@std/assert";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ElementNode } from "@herdr-relay/protocol";
import { alignDelta, nearestDelta, scrollTarget, useScrollTo } from "../src/render/scroll.ts";
import { installDom, quietly } from "./fake_dom.ts";

Deno.test("scroll alignment uses the nearest edge or center", () => {
  assertEquals(nearestDelta(-20, -10, 0, 100), -20);
  assertEquals(nearestDelta(110, 120, 0, 100), 20);
  assertEquals(nearestDelta(20, 40, 0, 100), 0);
  assertEquals(nearestDelta(-20, 120, 0, 100), 0);
  assertEquals(nearestDelta(-50, 70, 0, 100), -30);
  assertEquals(nearestDelta(30, 150, 0, 100), 30);
  assertEquals(alignDelta(110, 120, 0, 100, false), 20);
  assertEquals(alignDelta(110, 120, 0, 100, true), 65);
  assertEquals(alignDelta(20, 40, 0, 100, true), -20);
});

Deno.test("scroll targets decode item, center and bottom and reject invalid requests", () => {
  assertEquals(scrollTarget({ seq: 1, index: 0 }), { seq: 1, item: 0, center: false });
  assertEquals(scrollTarget({ seq: 2, index: 5, strategy: "top" }), { seq: 2, item: 5, center: false });
  assertEquals(scrollTarget({ seq: 3, index: 5, strategy: "center" }), { seq: 3, item: 5, center: true });
  assertEquals(scrollTarget({ seq: 4, bottom: true }), { seq: 4, item: "end", center: false });
  for (
    const value of [null, {}, { seq: -1, index: 0 }, { seq: 1.5, index: 0 }, { seq: 1, index: -1 }, {
      seq: 1,
      index: Number.MAX_SAFE_INTEGER + 1,
    }, { seq: 1, bottom: false }]
  ) {
    assertEquals(scrollTarget(value), null);
  }
});

Deno.test("mounted scroll requests apply once per sequence and ignore out-of-range children", async () => {
  const { doc } = installDom();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
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
    children: { item: (index: number) => index === 0 ? child : null },
  };
  const ref = { current: box as unknown as HTMLElement };
  function Probe({ request }: { request: ElementNode["scrollTo"] }) {
    useScrollTo(ref, {
      k: "el",
      tag: "div",
      style: { overflowY: "auto" },
      children: [{ k: "text", text: "item", style: {} }],
      scrollTo: request,
    }, 0);
    return null;
  }
  const root = createRoot(container as unknown as Element);
  await quietly(async () => {
    await act(() => root.render(createElement(Probe, { request: { seq: 1, index: 0 } })));
    assertEquals(box.scrollTop, 20);
    await act(() => root.render(createElement(Probe, { request: { seq: 1, index: 0 } })));
    assertEquals(box.scrollTop, 20);
    await act(() => root.render(createElement(Probe, { request: { seq: 2, index: 2 } })));
    assertEquals(box.scrollTop, 20);
    await act(() => root.render(createElement(Probe, { request: { seq: 3, bottom: true } })));
    assertEquals(box.scrollTop, 40);
    await act(() => root.unmount());
  });
  container.parentNode?.removeChild(container);
});
