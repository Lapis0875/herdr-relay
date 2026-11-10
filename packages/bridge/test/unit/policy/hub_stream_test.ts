import { assertEquals, assertStringIncludes } from "@std/assert";
import { HubStream } from "../../../src/policy/hub.ts";
import { HUB_LINE_MAX_BYTES } from "../../../src/policy/hub.table.ts";

const caller = { device: "act" as const, openUrlOnDevice: true };

Deno.test("HubStream buffers partial requests and preserves CRLF framing", () => {
  const stream = new HubStream();
  assertEquals(stream.write('{"op":"sub', caller), { kind: "send", text: "", opens: [] });
  assertEquals(stream.write('scribe"}\r', caller), { kind: "send", text: "", opens: [] });
  assertEquals(stream.write('\n{"op":"view"', caller), { kind: "send", text: '{"op":"subscribe"}\r\n', opens: [] });
  assertEquals(stream.write("}\n", caller), { kind: "send", text: '{"op":"view"}\n', opens: [] });
});

Deno.test("HubStream counts UTF-8 bytes at the line size boundary", () => {
  const prefix = '{"op":"subscribe","value":"';
  const suffix = '"}';
  const overhead = new TextEncoder().encode(prefix + suffix).length;
  const room = HUB_LINE_MAX_BYTES - overhead;
  const exact = prefix + "é".repeat(Math.floor(room / 2)) + "x".repeat(room % 2) + suffix;
  assertEquals(new TextEncoder().encode(exact).length, HUB_LINE_MAX_BYTES);
  const stream = new HubStream();
  const split = Math.floor(exact.length / 2);
  assertEquals(stream.write(exact.slice(0, split), caller), { kind: "send", text: "", opens: [] });
  assertEquals(stream.write(exact.slice(split) + "\n", caller), { kind: "send", text: exact + "\n", opens: [] });

  const tooLarge = exact.slice(0, -suffix.length) + "é" + suffix;
  const refused = new HubStream().write(tooLarge + "\n", caller);
  assertEquals(refused.kind, "refuse");
  if (refused.kind === "refuse") assertStringIncludes(refused.refusal.reason, "over");

  const partial = new HubStream();
  assertEquals(partial.write("é".repeat(HUB_LINE_MAX_BYTES / 2), caller).kind, "send");
  const overflow = partial.write("é", caller);
  assertEquals(overflow.kind, "refuse");
  if (overflow.kind === "refuse") assertStringIncludes(overflow.refusal.reason, "over");
  assertEquals(partial.write('{"op":"subscribe"}\n', caller).kind, "refuse");
});
