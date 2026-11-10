import { assert, assertEquals } from "@std/assert";
import { type BridgeMessage, decodeTerminalFrame, encodeTerminalFrame } from "@herdr-relay/protocol";
import {
  type AttachOptions,
  type CoreClientEvent,
  type CoreClientListener,
  type CoreTerminal,
  type TerminalStream,
} from "../../../src/core/mod.ts";
import { CoreConnection, negotiate } from "../../../src/core/connection.ts";
import type { SessionConnection } from "../../../src/server/mod.ts";
import {
  DRAIN_POLL_MS,
  MAX_BUFFERED_BYTES,
  RESUME_BUFFERED_BYTES,
  TerminalRelay,
} from "../../../src/terminal/relay.ts";
import { FakeCore, frame } from "../../fakes/core.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
function connection(scope: "read" | "act" = "act") {
  const messages: BridgeMessage[] = [];
  const frames: Uint8Array[] = [];
  const conn: SessionConnection & { bufferedAmount: number } = {
    id: scope,
    device: { id: scope, name: scope, scope },
    via: "local",
    bufferedAmount: 0,
    send: (message) => {
      messages.push(message);
      return true;
    },
    sendBinary: (frame) => {
      frames.push(frame);
      return true;
    },
    close: () => {},
  };
  return { conn, messages, frames };
}
const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const open = (id: number, mode: "observe" | "type" = "type") => ({ t: "term.open" as const, id, terminal: "t1", mode });

Deno.test("wire relay types only with act scope at the current size and emits no RESIZE or FOCUS", async () => {
  const fake = new FakeCore();
  fake.terminal.state = "live";
  fake.terminal.cols = 103;
  fake.terminal.rows = 37;
  let nextChannel = 2;
  const send = fake.send.bind(fake);
  fake.send = (chunk) => {
    if (chunk.length >= 9 && new DataView(chunk.buffer, chunk.byteOffset).getUint32(0, true) === 0) {
      const message = JSON.parse(new TextDecoder().decode(chunk.subarray(9)));
      if (message.result?.channel === 2 && message.result?.terminal) {
        message.result.channel = nextChannel++;
        send(frame(0, 0, bytes(JSON.stringify(message))));
        return;
      }
    }
    send(chunk);
  };
  const wire = new CoreConnection(fake.transport);
  const relay = new TerminalRelay({
    state: "up",
    terminals: new Map([["t1", facts(103, 37)]]),
    on: () => () => {},
    attach: async (terminal, options) => {
      const current = await wire.call<CoreTerminal>("terminal.get", { terminal });
      return wire.attach({ ...options, terminal, cols: current.cols, rows: current.rows });
    },
  }, { log: () => {} });
  const act = connection();
  const read = connection("read");
  try {
    await negotiate(wire, 1000);
    await relay.message(read.conn, open(1));
    assertEquals(read.messages, [{
      t: "ack",
      id: 1,
      ok: false,
      error: "read-only-device",
      message: "read-only device",
    }]);
    await relay.message(read.conn, open(2, "observe"));
    await relay.input(read.conn, encodeTerminalFrame(1, bytes("forbidden")));
    await relay.message(act.conn, open(3));
    await relay.input(act.conn, encodeTerminalFrame(1, bytes("hello")));
    await tick();
    const attaches = fake.requests.filter((r) => r.method === "terminal.attach");
    assertEquals(attaches.map((r) => r.params), [
      { terminal: "t1", cols: 103, rows: 37, observe: true, resize_notifications: true },
      { terminal: "t1", cols: 103, rows: 37, observe: true, resize_notifications: true },
      { terminal: "t1", cols: 103, rows: 37, observe: false },
    ]);
    assertEquals(fake.frames.filter((f) => f.channel !== 0 && f.kind === 0).map((f) => [...f.payload]), [[
      ...bytes("hello"),
    ]]);
    assertEquals(fake.frames.filter((f) => f.kind === 3 || f.kind === 4), []);
  } finally {
    relay.dispose();
    await wire.close();
  }
});

function facts(cols = 80, rows = 24): CoreTerminal {
  return { address: "t1", labels: {}, argv: [], cwd: "", state: "live", created_ms: 0, screen: "exact", cols, rows };
}
class Stream implements TerminalStream {
  readonly terminal = "t1";
  readonly channel = 1;
  readonly resizeNotifications = true;
  readonly automaticInput = false;
  readonly closed = new Promise<{ by: "client"; detail: null }>(() => {});
  readonly typed: Uint8Array[] = [];
  ended = false;
  constructor(
    readonly mode: "observe" | "type",
    readonly cols: number,
    readonly rows: number,
    readonly facts: CoreTerminal,
  ) {}
  input(data: Uint8Array) {
    this.typed.push(data);
  }
  close() {
    this.ended = true;
  }
}
class RelayFake {
  readonly state = "up" as const;
  readonly terminals = new Map([["t1", facts()]]);
  readonly listeners = new Set<CoreClientListener>();
  readonly calls: { options: AttachOptions; stream: Stream }[] = [];
  typeRace = false;
  hold: Promise<void> | null = null;
  on(fn: CoreClientListener) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(event: CoreClientEvent) {
    for (const fn of this.listeners) fn(event);
  }
  async attach(_terminal: string, options: AttachOptions): Promise<TerminalStream> {
    const current = this.terminals.get("t1")!;
    const stream = new Stream(options.mode, current.cols, current.rows, { ...current });
    this.calls.push({ options, stream });
    if (this.hold && options.mode === "observe") await this.hold;
    if (options.mode === "type" && this.typeRace) {
      this.typeRace = false;
      this.terminals.set("t1", facts(100, 30));
      this.emit({ type: "event", kind: "size", seq: 1, terminal: "t1", machine: null, data: { cols: 100, rows: 30 } });
    }
    return stream;
  }
}

Deno.test("size race closes stale type attach before typing, retries current size", async () => {
  const core = new RelayFake();
  const relay = new TerminalRelay(core, { log: () => {} });
  const { conn } = connection();
  try {
    await relay.message(conn, open(1));
    core.typeRace = true;
    await relay.input(conn, encodeTerminalFrame(1, bytes("x")));
    const types = core.calls.filter((c) => c.options.mode === "type").map((c) => c.stream);
    assertEquals(types.length, 2);
    assert(types[0].ended);
    assertEquals(types[0].typed, []);
    assertEquals([types[1].cols, types[1].rows], [100, 30]);
    assertEquals(types[1].typed, [bytes("x")]);
    core.emit({ type: "event", kind: "size", seq: 2, terminal: "t1", machine: null, data: { cols: 101, rows: 30 } });
    assert(types[1].ended);
  } finally {
    relay.dispose();
  }
});

Deno.test("backpressure detaches before splitting a frame and reattaches after drain", async () => {
  const core = new RelayFake();
  const relay = new TerminalRelay(core, { log: () => {} });
  const { conn, frames, messages } = connection();
  try {
    await relay.message(conn, open(1, "observe"));
    const first = core.calls[0];
    conn.bufferedAmount = MAX_BUFFERED_BYTES - 8;
    first.options.onData!(bytes("abcd"));
    assertEquals(decodeTerminalFrame(frames[0]), { channel: 1, bytes: bytes("abcd") });
    conn.bufferedAmount = MAX_BUFFERED_BYTES - 7;
    first.options.onData!(bytes("abcd"));
    assert(first.stream.ended);
    assertEquals(frames.length, 1);
    first.options.onData!(bytes("late"));
    assertEquals(frames.length, 1);
    conn.bufferedAmount = RESUME_BUFFERED_BYTES + 1;
    await tick(DRAIN_POLL_MS * 2);
    assertEquals(core.calls.length, 1);
    conn.bufferedAmount = RESUME_BUFFERED_BYTES;
    await tick(DRAIN_POLL_MS * 2);
    assertEquals(core.calls.length, 2);
    core.calls[1].options.onData!(bytes("new paint"));
    assertEquals(decodeTerminalFrame(frames[1]), { channel: 1, bytes: bytes("new paint") });
    assertEquals(messages.filter((m) => m.t === "term.size").length, 2);
  } finally {
    relay.dispose();
  }
});

Deno.test("acks remain in request order when the first attach is delayed", async () => {
  const core = new RelayFake();
  const gate = Promise.withResolvers<void>();
  core.hold = gate.promise;
  const relay = new TerminalRelay(core, { log: () => {} });
  const { conn, messages } = connection();
  try {
    const first = relay.message(conn, open(10, "observe"));
    const second = relay.message(conn, { t: "term.close", id: 11, terminal: "t1" });
    await tick();
    assertEquals(messages.filter((m) => m.t === "ack"), []);
    gate.resolve();
    await Promise.all([first, second]);
    assertEquals(messages.filter((m) => m.t === "ack").map((m) => m.id), [10, 11]);
  } finally {
    gate.resolve();
    relay.dispose();
  }
});
