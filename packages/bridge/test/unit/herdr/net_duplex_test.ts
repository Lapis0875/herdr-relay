import { assert, assertEquals, assertRejects } from "@std/assert";
import { delay } from "@std/async";
import { join } from "@std/path";
import { HubProxy } from "../../../src/herdr/net.ts";

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(`operation exceeded ${ms} ms`)), ms);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("hub socket allows a write while a read waits, and close cancels both lanes", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "duplex-" });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  let peer: Deno.Conn | undefined;
  let proxy: HubProxy | undefined;
  try {
    const cache = await Deno.realPath(dir);
    const port = (listener.addr as Deno.NetAddr).port;
    await Deno.writeTextFile(join(cache, "hub.json"), JSON.stringify({ port }));
    const profile = { id: "duplex-test", folders: ["duplex"], net: { hubPortFrom: "cockpit.json" as const } };
    const origin = { session: "synthetic-act", scope: "act" as const, connected: true };
    proxy = new HubProxy({ cockpit: () => ({ cache }), profileFor: () => profile, policyLog: () => {}, log: () => {} });
    const accepted = listener.accept();
    void accepted.catch(() => {});
    const id = await proxy.connect("duplex", 1, "127.0.0.1", port);
    peer = await accepted;
    const pendingRead = proxy.read("duplex", 1, id, 1024);
    void pendingRead.catch(() => {});
    await delay(25);
    const request = "duplex-probe";
    const write = proxy.write("duplex", 1, id, request, origin);
    await within(write, 1000);
    const expected = new TextEncoder().encode(request);
    const bytes = new Uint8Array(expected.length);
    let received = 0;
    while (received < bytes.length) {
      const n = await within(peer.read(bytes.subarray(received)), 1000);
      assert(n !== null, "echo peer closed before receiving the complete request");
      received += n;
    }
    assertEquals(new TextDecoder().decode(bytes), request);
    await peer.write(bytes);
    assertEquals(atob((await within(pendingRead, 1000))!), request);
    const blockedRead = proxy.read("duplex", 1, id, 1024);
    await delay(25);
    // The peer intentionally stops reading, so the large write is in flight
    // rather than merely waiting in the JavaScript queue when close occurs.
    const queuedWrite = proxy.write("duplex", 1, id, "x".repeat(16 * 1024 * 1024), origin);
    let writeSettled = false;
    void queuedWrite.then(() => {
      writeSettled = true;
    }, () => {
      writeSettled = true;
    });
    await delay(50);
    assert(!writeSettled, "fixture did not create an in-flight blocked write");
    proxy.close("duplex", id);
    await Promise.all([
      assertRejects(() => within(blockedRead, 1000)),
      assertRejects(() => within(queuedWrite, 1000)),
    ]);
  } finally {
    proxy?.closeAll();
    peer?.close();
    listener.close();
    await Deno.remove(dir, { recursive: true });
  }
});
