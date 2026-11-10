// Helpers and per-kind rules of the client ⇄ bridge and control protocols, and device classification.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  classifyDevice,
  type ClientEvent,
  ClientMessageSchema,
  copyBelongsTo,
  decodeHostToBridge,
  decodeTerminalFrame,
  encodeTerminalFrame,
  EVENT_KINDS,
  formatCopyId,
  parseCopyId,
  validate,
} from "../mod.ts";

const modifiers = { shift: false, control: true, alt: false, platform: false, function: false };
const point = { x: 10, y: 20 };
const bounds = { x: 0, y: 0, width: 100, height: 30 };

const DATA: Record<ClientEvent["kind"], Record<string, unknown>> = {
  click: { click_count: 2, modifiers, key: "row-7" },
  mousedown: { button: "right", click_count: 1, position: point, local_position: point, bounds, modifiers },
  mouseup: { button: "left", click_count: 1, position: point, modifiers },
  mousemove: { position: point, local_position: point, bounds, modifiers },
  hover: { hovered: false },
  wheel: { delta: { x: 0, y: -40 }, touch_phase: "moved", position: point, modifiers },
  key: { key: "s", keystroke: "cmd-s", key_char: "s", modifiers, is_held: false },
  size: { width: 320, height: 48 },
  input: { value: "hello", event: "submit", secondary: false, shift: true },
  link: { href: "https://github.com/example/example" },
};

Deno.test("every event kind validates with its own payload and fails with another kind's", () => {
  assertEquals(Object.keys(DATA).sort(), [...EVENT_KINDS].sort());
  for (const kind of EVENT_KINDS) {
    const msg = { t: "event", id: 1, view: "tabs:tabs", handler: 3, kind, data: DATA[kind] };
    const r = validate(ClientMessageSchema, msg);
    assert(r.ok, `${kind}: ${JSON.stringify(r.ok ? [] : r.errors)}`);
    const other = kind === "hover" ? "link" : "hover";
    assert(!validate(ClientMessageSchema, { ...msg, data: DATA[other] }).ok, `${kind} with ${other} data`);
  }
  assert(
    validate(ClientMessageSchema, {
      t: "event",
      id: 1,
      view: "v:v",
      handler: 1,
      kind: "size",
      data: { sizes: [268, 900] },
    }).ok,
  );
  assert(
    validate(ClientMessageSchema, { t: "event", id: 1, view: "v:v", handler: 1, kind: "input", data: { value: true } })
      .ok,
  );
  assert(
    !validate(ClientMessageSchema, {
      t: "event",
      id: 1,
      view: "v:v",
      handler: 1,
      kind: "link",
      data: { href: "javascript:alert(1)" },
    }).ok,
  );
});

Deno.test("terminal frames: u32 big-endian channel header", () => {
  const frame = encodeTerminalFrame(258, new TextEncoder().encode("ls\r\n"));
  assertEquals([...frame.subarray(0, 4)], [0, 0, 1, 2]);
  const { channel, bytes } = decodeTerminalFrame(frame);
  assertEquals(channel, 258);
  assertEquals(new TextDecoder().decode(bytes), "ls\r\n");
  const offset = new Uint8Array([9, 9, ...frame]).subarray(2);
  assertEquals(decodeTerminalFrame(offset).channel, 258);
  assertThrows(() => decodeTerminalFrame(new Uint8Array(3)), RangeError);
});

Deno.test("copy ids: parse, format and the trust rule", () => {
  assertEquals(parseCopyId("lstack-herdr-cockpit:cockpit-sidebar"), {
    folder: "lstack-herdr-cockpit",
    kind: "block",
    id: "cockpit-sidebar",
  });
  assertEquals(parseCopyId("lstack-herdr-cockpit:overlay:o3"), {
    folder: "lstack-herdr-cockpit",
    kind: "overlay",
    id: "o3",
  });
  assertEquals(parseCopyId("lstack-herdr-cockpit:pane:mac/p1"), {
    folder: "lstack-herdr-cockpit",
    kind: "pane",
    id: "mac/p1",
  });
  assertEquals(parseCopyId("tabs:overlay"), { folder: "tabs", kind: "block", id: "overlay" });
  for (const bad of ["queue", ":queue", "tabs:", "../x:y", "a b:c"]) assertEquals(parseCopyId(bad), null, bad);
  for (const copy of ["tabs:tabs", "files:overlay:o1", "changes:pane:p2"]) {
    assertEquals(formatCopyId(parseCopyId(copy)!), copy);
  }
  assert(copyBelongsTo("files:files", "files"));
  assert(!copyBelongsTo("lstack-herdr-cockpit:sidebar", "files"), "a copy claimed by another folder is forged");
  assert(!copyBelongsTo("files", "files"));
});

Deno.test("control lines decode with the host → bridge schema", () => {
  const ok = decodeHostToBridge('{"t":"hello","token":"abc","pid":1234,"folder":"tabs"}');
  assert(ok.ok && ok.value.t === "hello" && ok.value.folder === "tabs");
  assert(!decodeHostToBridge('{"t":"boot"}').ok, "a bridge → host message is not a host line");
  assert(!decodeHostToBridge("").ok);
});

Deno.test("device classes (DESIGN.md §3)", () => {
  const cases: [number, number, boolean, string][] = [
    [390, 844, false, "phone"],
    [844, 390, false, "phone"],
    [599, 1200, false, "phone"],
    [820, 1180, false, "tablet-portrait"],
    [1180, 820, false, "tablet-landscape"],
    [1366, 1024, false, "tablet-landscape"],
    [1366, 1024, true, "desktop"],
    [1180, 820, true, "tablet-landscape"],
    [1440, 900, true, "desktop"],
  ];
  for (const [w, h, fine, expected] of cases) {
    assertEquals(classifyDevice({ w, h }, fine), expected, `${w}×${h} fine=${fine}`);
  }
});
