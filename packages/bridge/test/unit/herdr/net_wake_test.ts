import { assertEquals, assertRejects } from "@std/assert";
import { delay } from "@std/async";
import { join } from "@std/path";
import { HubProxy } from "../../../src/herdr/net.ts";

const NOTE = '{"note":"opened https://example.com/pr/1","pending":{},"refreshing":{}}\n';
const OPEN =
  JSON.stringify({ op: "act", token: "t", app: "inbox", action: "open_url", args: ["https://example.com/pr/1"] }) +
  "\n";
const SUB = JSON.stringify({ op: "subscribe", token: "t", views: ["agents"] }) + "\n";
const origin = { session: "dev", scope: "act" as const, connected: true };

async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(`${what}: no answer within 1000 ms`)), 1000);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function hubLine(peer: Deno.Conn): Promise<string> {
  let text = "";
  const buf = new Uint8Array(4096);
  while (!text.endsWith("\n")) {
    const n = await within(peer.read(buf), "fake hub read");
    if (n === null) throw new Error("proxy closed before a full request");
    text += new TextDecoder().decode(buf.subarray(0, n));
  }
  return text;
}

async function fixture() {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.realPath(await Deno.makeTempDir({ dir: ".tmp", prefix: "netwake-" }));
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  await Deno.writeTextFile(join(dir, "hub.json"), JSON.stringify({ port }));
  const profile = {
    id: "netwake",
    folders: ["netwake"],
    net: { hubPortFrom: "cockpit.json" as const, writes: "cockpit-hub" as const },
  };
  const proxy = new HubProxy({
    cockpit: () => ({ cache: dir }),
    profileFor: () => profile,
    policyLog: () => {},
    log: () => {},
    toast: () => true,
  });
  const accepted = listener.accept();
  const id = await proxy.connect("netwake", 1, "127.0.0.1", port);
  const peer = await accepted;
  const read = (max = 1024) =>
    proxy.read("netwake", 1, id, max).then((b64) =>
      b64 === null ? null : new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)))
    );
  const write = (text: string) => proxy.write("netwake", 1, id, text, origin);
  const cleanup = async () => {
    proxy.closeAll();
    try {
      peer.close();
    } catch { /* closed by the test */ }
    listener.close();
    await Deno.remove(dir, { recursive: true });
  };
  return { proxy, id, peer, read, write, cleanup };
}

Deno.test("read waiting before intercepted open_url wakes with the note; hub bytes follow in order", async () => {
  const f = await fixture();
  try {
    const r1 = f.read();
    await delay(25);
    await within(f.write(OPEN), "open_url write");
    assertEquals(await within(r1, "read pending before open_url"), NOTE);
    await within(f.write(SUB), "subscribe write");
    assertEquals(await hubLine(f.peer), SUB);
    await f.peer.write(new TextEncoder().encode("HUB-1 first answer\n"));
    await delay(50);
    assertEquals(await within(f.read(4), "buffered read (4 bytes)"), "HUB-");
    assertEquals(await within(f.read(), "buffered remainder"), "1 first answer\n");
    const r4 = f.read();
    await delay(25);
    await f.peer.write(new TextEncoder().encode("HUB-2 second\n"));
    assertEquals(await within(r4, "live read"), "HUB-2 second\n");
    f.peer.close();
    assertEquals(await within(f.read(), "read at hub EOF"), null);
    assertEquals(await within(f.read(), "read after hub EOF"), null);
  } finally {
    await f.cleanup();
  }
});

Deno.test("two waiting reads receive the note and hub bytes in order; close rejects remaining reads", async () => {
  const f = await fixture();
  try {
    const r1 = f.read();
    const r2 = f.read();
    await delay(25);
    await within(f.write(OPEN + SUB), "open_url + subscribe write");
    assertEquals(await within(r1, "first waiting read"), NOTE);
    assertEquals(await hubLine(f.peer), SUB);
    await f.peer.write(new TextEncoder().encode("HUB-A\n"));
    assertEquals(await within(r2, "second waiting read"), "HUB-A\n");
    const r3 = f.read();
    const r4 = f.read();
    await delay(25);
    f.proxy.close("netwake", f.id);
    await assertRejects(() => within(r3, "r3 after close"), Error, "the connection is closed");
    await assertRejects(() => within(r4, "r4 after close"), Error, "the connection is closed");
  } finally {
    await f.cleanup();
  }
});
