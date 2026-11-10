import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { CoreClient, type CoreClientEvent } from "../../../src/core/client.ts";
import { CoreConnection, negotiate } from "../../../src/core/connection.ts";
import { CoreError } from "../../../src/core/errors.ts";
import { FrameReader, MAX_FRAME } from "../../../src/core/frames.ts";
import { spawnHcConnect } from "../../../src/core/transport.ts";
import type { CoreMethod } from "../../../src/core/types.ts";
import { FakeCore, frame } from "../../fakes/core.ts";

const text = new TextEncoder();

Deno.test("generation 1 negotiates minimum version and discovers methods", async () => {
  const fake = new FakeCore();
  const connection = new CoreConnection(fake.transport);
  try {
    const { hello, schema } = await negotiate(connection, 1000);
    assertEquals(hello.version, "0.1.19");
    assertEquals(schema.info.version, "0.1.19");
    assertEquals(fake.requests.map((r) => r.method), ["hello", "rpc.discover"]);
    assertEquals(fake.requests[0].params, { generation: 1, framed: true });
  } finally {
    await connection.close();
  }
});

Deno.test("negotiation rejects old, wrong-generation, unframed and incomplete cores", async () => {
  const cases = [
    { options: { version: "0.1.18" }, message: "hc update" },
    { options: { generation: 2 }, message: "generation" },
    { options: { framed: false }, message: "frames" },
    { options: { methods: ["hello"] }, message: "lacks" },
    { options: { described: ["hello"] }, message: "describe" },
  ];
  for (const { options, message } of cases) {
    const fake = new FakeCore(options);
    const connection = new CoreConnection(fake.transport);
    try {
      const error = await assertRejects(() => negotiate(connection, 1000), CoreError, message);
      assertEquals(error.kind, "incompatible");
    } finally {
      await connection.close();
    }
  }
});

Deno.test("framed RPC handles single-byte and irregular chunk boundaries", async () => {
  for (const chunks of [1, 7, 19]) {
    const fake = new FakeCore({ chunks });
    const connection = new CoreConnection(fake.transport);
    try {
      await negotiate(connection, 1000);
      const answer = await connection.call("doc.get", { name: "herdr-app" }, { timeout: 1000 });
      assertEquals(answer, { value: { spaces: [] }, version: 1 });
    } finally {
      await connection.close();
    }
  }
});

Deno.test("frame reader handles coalesced frames, split headers and zero-length payload", () => {
  const first = frame(42, 0, text.encode("hello"));
  const second = frame(9, 2);
  const bytes = new Uint8Array(first.length + second.length);
  bytes.set(first);
  bytes.set(second, first.length);
  for (const size of [1, 4, 9, bytes.length]) {
    const reader = new FrameReader();
    const received: unknown[] = [];
    for (let pos = 0; pos < bytes.length; pos += size) {
      reader.push(bytes.subarray(pos, pos + size), (channel, kind, payload) => {
        received.push({ channel, kind, payload: [...payload] });
      });
    }
    assertEquals(received, [
      { channel: 42, kind: 0, payload: [...text.encode("hello")] },
      { channel: 9, kind: 2, payload: [] },
    ]);
    assert(reader.idle);
  }
});

Deno.test("oversized announced frame is rejected before payload allocation", async () => {
  const fake = new FakeCore({ chunks: 1 });
  const connection = new CoreConnection(fake.transport);
  try {
    await negotiate(connection, 1000);
    const header = new Uint8Array(9);
    new DataView(header.buffer).setUint32(5, MAX_FRAME + 1, true);
    fake.send(header);
    const error = await connection.ended;
    assertEquals(error.kind, "protocol");
    assert(error.message.includes("exceeds"));
  } finally {
    await connection.close();
  }
});

Deno.test("disconnect causes down and a fresh reset with replacement snapshot", async () => {
  const cores = [new FakeCore({ seq: 3, address: "old" }), new FakeCore({ seq: 8, address: "new" })];
  let count = 0;
  const client = new CoreClient({
    transport: () => cores[Math.min(count++, 1)].transport,
    backoffMs: [0],
    timeoutMs: 1000,
    log: () => {},
  });
  const events: CoreClientEvent[] = [];
  const reconnected = Promise.withResolvers<void>();
  client.on((event) => {
    events.push(event);
    if (event.type === "reset" && event.reason === "reconnected") reconnected.resolve();
  });
  try {
    await client.ready();
    cores[0].disconnect();
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(() => timeout.reject(new Error("reconnect timed out")), 1000);
    try {
      await Promise.race([reconnected.promise, timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
    assertEquals(events.map((event) => event.type), ["reset", "down", "reset"]);
    const resets = events.filter((event) => event.type === "reset");
    assertEquals(
      resets.map((event) => [event.reason, event.seq, event.terminals.map((terminal) => terminal.address)]),
      [
        ["connected", 3, ["old"]],
        ["reconnected", 8, ["new"]],
      ],
    );
    assertEquals([...client.terminals.keys()], ["new"]);
  } finally {
    await client.close();
  }
});

Deno.test("observe attach uses actual size and sends neither resize, focus nor input", async () => {
  const fake = new FakeCore();
  const client = new CoreClient({ transport: () => fake.transport, timeoutMs: 1000, log: () => {} });
  try {
    const received: number[] = [];
    const stream = await client.attach("t1", { mode: "observe", onData: (data) => received.push(...data) });
    fake.send(frame(2, 0, text.encode("paint")));
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 0);
    await tick.promise;
    assertEquals(received, [...text.encode("paint")]);
    assertThrows(() => stream.input(text.encode("x")), CoreError, "observe");
    stream.close();
    await stream.closed;
    const attach = fake.requests.find((r) => r.method === "terminal.attach");
    assertEquals(attach?.params, { terminal: "t1", cols: 80, rows: 24, observe: true });
    assertEquals(fake.frames.filter((f) => f.channel === 2).map((f) => f.kind), [1, 2]);
  } finally {
    await client.close();
  }
});

Deno.test("write methods are refused before reaching the core", async () => {
  const fake = new FakeCore();
  const connection = new CoreConnection(fake.transport);
  try {
    await negotiate(connection, 1000);
    for (const method of ["doc.set", "terminal.run", "terminal.send", "terminal.kill", "unknown"]) {
      const error = await assertRejects(() => connection.call(method as CoreMethod), CoreError);
      assertEquals(error.kind, "refused");
    }
    assertEquals(fake.requests.map((request) => request.method), ["hello", "rpc.discover"]);
  } finally {
    await connection.close();
  }
});

Deno.test("hc connect child does not inherit HC variables", async () => {
  const command = `${Deno.cwd()}/packages/bridge/test/unit/core/fake-hc`;
  const previous = Deno.env.get("HC_SOCKET");
  try {
    Deno.env.set("HC_SOCKET", "must-not-reach-child");
    const transport = spawnHcConnect({ command });
    const output = await new Response(transport.readable).text();
    await transport.closed;
    assert(!output.split("\n").some((line) => line.startsWith("HC_")), output);
    assert(output.split("\n").some((line) => line.startsWith("HOME=")));
    assert(output.split("\n").some((line) => line.startsWith("PATH=")));
  } finally {
    if (previous === undefined) Deno.env.delete("HC_SOCKET");
    else Deno.env.set("HC_SOCKET", previous);
  }
});
