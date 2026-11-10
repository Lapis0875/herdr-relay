import { assertEquals } from "@std/assert";
import { delay } from "@std/async";
import {
  Auth,
  DeviceStore,
  ensureStateDir,
  ensureToken,
  LOCAL_DEVICE,
  PairingCodes,
  TicketBook,
} from "../../../src/auth/mod.ts";
import { startServer } from "../../../src/server/server.ts";

Deno.test("revocation sweep notifies sessions exactly once, including a disconnected device", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const state = await Deno.makeTempDir({ dir: ".tmp", prefix: "revoke-sweep-" });
  await ensureStateDir(state);
  const token = await ensureToken(state);
  const devices = new DeviceStore(state);
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const dns = "mac.tailnet-test.ts.net";
  const auth = new Auth({
    port,
    token,
    devices,
    tickets: new TicketBook(),
    pairing: new PairingCodes(),
    tailnetEnabled: true,
    peer: () => Promise.resolve(true),
    tailnet: { owner: "owner@github", dns },
  });
  const revoked: string[] = [];
  const sessions = {
    open() {},
    message() {},
    binary() {},
    close() {},
    revokeDevice(id: string) {
      revoked.push(id);
    },
  };
  const server = startServer({ port, auth, sessions, webRoot: null, log: () => {} });
  const sockets: Deno.Conn[] = [];
  async function connect(
    ticket: string,
    tailnet: boolean,
  ): Promise<{ status: number; closed: Promise<string>; conn: Deno.Conn }> {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    sockets.push(conn);
    const headers = tailnet
      ? { host: dns, "tailscale-user-login": "owner@github", origin: `https://${dns}` }
      : { host: `127.0.0.1:${port}` };
    const request = [
      `GET /herdr-relay/ws?ticket=${ticket} HTTP/1.1`,
      ...Object.entries({
        ...headers,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      }).map(([key, value]) => `${key}: ${value}`),
      "",
      "",
    ].join("\r\n");
    await conn.write(new TextEncoder().encode(request));
    let bytes = new Uint8Array(0);
    async function read() {
      const chunk = new Uint8Array(4096);
      const n = await conn.read(chunk);
      if (n === null) throw new Error("EOF");
      const next = new Uint8Array(bytes.length + n);
      next.set(bytes);
      next.set(chunk.subarray(0, n), bytes.length);
      bytes = next;
    }
    while (!new TextDecoder().decode(bytes).includes("\r\n\r\n")) await read();
    const header = new TextDecoder().decode(bytes);
    bytes = bytes.slice(header.indexOf("\r\n\r\n") + 4);
    const closed = (async () => {
      for (;;) {
        while (bytes.length < 2) await read();
        const opcode = bytes[0] & 15;
        const length = bytes[1] & 127;
        while (bytes.length < 2 + length) await read();
        const payload = bytes.slice(2, 2 + length);
        bytes = bytes.slice(2 + length);
        if (opcode === 8) return `${(payload[0] << 8) | payload[1]} ${new TextDecoder().decode(payload.slice(2))}`;
      }
    })().catch((error) => `no close frame: ${error}`);
    return { status: Number(header.split(" ")[1]), closed, conn };
  }
  try {
    const a = (await devices.add("A", "act")).device;
    const b = (await devices.add("B", "read")).device;
    const c = (await devices.add("C", "read")).device;
    const mint = (id: string, scope: "read" | "act") =>
      auth.tickets.mint({ via: "tailnet", device: { id, name: id, scope } });
    const a1 = await connect(mint(a.id, "act"), true);
    const a2 = await connect(mint(a.id, "act"), true);
    const b1 = await connect(mint(b.id, "read"), true);
    const c1 = await connect(mint(c.id, "read"), true);
    const local = await connect(auth.tickets.mint({ via: "local", device: LOCAL_DEVICE }), false);
    assertEquals([a1.status, a2.status, b1.status, c1.status, local.status], [101, 101, 101, 101, 101]);
    b1.conn.close();
    await delay(200);
    await devices.revoke(a.id);
    await devices.revoke(b.id);
    assertEquals(await Promise.all([a1.closed, a2.closed]), ["1008 device revoked", "1008 device revoked"]);
    await delay(4500);
    assertEquals(revoked.filter((id) => id === a.id).length, 1);
    assertEquals(revoked.filter((id) => id === b.id).length, 1);
    assertEquals(revoked.filter((id) => id === c.id).length, 0);
    assertEquals(revoked.filter((id) => id === LOCAL_DEVICE.id).length, 0);
    assertEquals(revoked.length, 2);
  } finally {
    for (const socket of sockets) {
      try {
        socket.close();
      } catch { /* already closed */ }
    }
    await server.shutdown();
    await Deno.remove(state, { recursive: true });
  }
});
