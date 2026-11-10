import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { request as httpRequest } from "node:http";
import { Auth } from "../../../src/auth/auth.ts";
import { DeviceStore } from "../../../src/auth/devices.ts";
import { PairingCodes } from "../../../src/auth/pairing.ts";
import { TicketBook } from "../../../src/auth/tickets.ts";
import { ensureStateDir } from "../../../src/auth/token.ts";
import { startServer } from "../../../src/server/server.ts";
import type { SessionHandler } from "../../../src/server/connection.ts";

const dns = "machine.example.ts.net";
const owner = "owner@example.com";
const token = "test-loopback-token";

async function fixture(insecure = false, sessions?: SessionHandler) {
  const home = await Deno.makeTempDir({ dir: ".tmp", prefix: "server-home-" });
  const state = `${home}/.herdr/herdr-relay`;
  await ensureStateDir(state);
  const devices = new DeviceStore(state);
  const pairing = insecure ? null : new PairingCodes();
  const tickets = new TicketBook();
  const auth = new Auth({
    port: 0,
    token,
    devices,
    pairing,
    tickets,
    tailnetEnabled: !insecure,
    tailnet: { dns, owner },
    peer: () => Promise.resolve(true),
  });
  const server = startServer({ port: 0, auth, sessions, webRoot: null, log: () => {} });
  Object.assign(auth, { port: server.addr.port });
  const base = `http://127.0.0.1:${server.addr.port}/herdr-relay`;
  const cleanup = async () => {
    await server.shutdown();
    await Deno.remove(home, { recursive: true });
  };
  return { auth, base, cleanup, devices, pairing, tickets };
}

// Fetch rewrites Host to the URL authority. Use an HTTP client that preserves the
// explicit MagicDNS Host while connecting only to the loopback test listener.
async function tailnetRequest(
  url: string,
  options: { method?: string; headers: Record<string, string>; body?: string },
): Promise<Response> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: options.method ?? "GET", headers: options.headers }, (response) => {
      const chunks: Uint8Array[] = [];
      response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string") headers.set(key, value);
          else if (value) { for (const part of value) headers.append(key, part); }
        }
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

Deno.test("pairing route issues scoped secure cookie, requires owner and rejects reuse", async () => {
  const f = await fixture();
  try {
    const codeResponse = await fetch(`${f.base}/api/pair/code`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: "read", name: "phone" }),
    });
    assertEquals(codeResponse.status, 200);
    const { code } = await codeResponse.json();
    assertMatch(code, /^\d{6}$/);
    const headers = {
      host: dns,
      "tailscale-user-login": owner,
      origin: `https://${dns}`,
      "x-herdr-relay": "1",
      "content-type": "application/json",
    };
    const request = (overrides: Record<string, string> = {}) =>
      tailnetRequest(`${f.base}/api/pair`, {
        method: "POST",
        headers: { ...headers, ...overrides },
        body: JSON.stringify({ code, name: "ignored" }),
      });
    const other = await request({ "tailscale-user-login": "other@example.com" });
    assertEquals(other.status, 403);
    await other.body?.cancel();
    const response = await request();
    assertEquals(response.status, 200);
    const cookie = response.headers.get("set-cookie") ?? "";
    assertMatch(cookie, /^__Secure-herdr-relay-device=/);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/herdr-relay"]) {
      assertStringIncludes(cookie, flag);
    }
    const body = await response.json();
    assertEquals(body.device.scope, "read");
    assertEquals(body.device.name, "phone");
    const replay = await request();
    assertEquals(replay.status, 403);
    await replay.body?.cancel();
    const ticket = await tailnetRequest(`${f.base}/api/ticket`, {
      headers: { host: dns, "tailscale-user-login": owner, cookie: cookie.split(";")[0], "x-herdr-relay": "1" },
    });
    assertEquals(ticket.status, 200);
    assert(typeof (await ticket.json()).ticket === "string");
    const missingHeader = await tailnetRequest(`${f.base}/api/ticket`, {
      headers: { host: dns, "tailscale-user-login": owner, cookie: cookie.split(";")[0] },
    });
    assertEquals(missingHeader.status, 403);
    await missingHeader.body?.cancel();
  } finally {
    await f.cleanup();
  }
});

Deno.test("insecure mode denies tailnet and both pairing paths but keeps local token access", async () => {
  const f = await fixture(true);
  try {
    const local = await fetch(`${f.base}/api/hello`, { headers: { authorization: `Bearer ${token}` } });
    assertEquals(local.status, 200);
    assertEquals((await local.json()).pairing, false);
    const mint = await fetch(`${f.base}/api/pair/code`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });
    assertEquals(mint.status, 403);
    await mint.body?.cancel();
    const remote = await tailnetRequest(`${f.base}/api/hello`, {
      headers: { host: dns, "tailscale-user-login": owner },
    });
    assertEquals(remote.status, 403);
    await remote.body?.cancel();
    const pair = await tailnetRequest(`${f.base}/api/pair`, {
      method: "POST",
      headers: { host: dns, "tailscale-user-login": owner, origin: `https://${dns}`, "x-herdr-relay": "1" },
      body: "{}",
    });
    assertEquals(pair.status, 403);
    await pair.body?.cancel();
  } finally {
    await f.cleanup();
  }
});

Deno.test("read-only WebSocket refuses write messages and drops binary before session dispatch", async () => {
  const messages: string[] = [];
  let binaries = 0;
  const sessions: SessionHandler = {
    open: () => {},
    message: (conn, msg) => {
      messages.push(msg.t);
      if (msg.t === "nav") conn.send({ t: "ack", id: msg.id, ok: true });
    },
    binary: () => {
      binaries++;
    },
    close: () => {},
  };
  const f = await fixture(false, sessions);
  try {
    const ticket = f.tickets.mint({ via: "local", device: { id: "read", name: "reader", scope: "read" } });
    const socket = new WebSocket(`${f.base.replace("http:", "ws:")}/ws?ticket=${ticket}`);
    const opened = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<unknown[]>();
    const replies: unknown[] = [];
    socket.onopen = () => opened.resolve();
    socket.onerror = () => opened.reject(new Error("WebSocket connection failed"));
    socket.onmessage = (event) => {
      replies.push(JSON.parse(String(event.data)));
      if (replies.length === 5) completed.resolve(replies);
    };
    await opened.promise;
    const send = (value: unknown) => socket.send(JSON.stringify(value));
    send({ t: "hello", v: 1, device: "reader", class: "phone", viewport: { w: 320, h: 640, dpr: 1 } });
    const modifiers = { shift: false, control: false, alt: false, platform: false, function: false };
    send({ t: "event", id: 1, view: "v", handler: 1, kind: "key", data: { key: "a", keystroke: "a", modifiers } });
    send({ t: "event", id: 2, view: "v", handler: 1, kind: "input", data: { value: "text" } });
    send({ t: "command", id: 3, name: "terminal.run" });
    send({ t: "term.open", id: 4, terminal: "term", mode: "type" });
    socket.send(new Uint8Array([0, 0, 0, 1, 65]));
    send({ t: "nav", id: 5, action: "pop" });
    const result = await completed.promise as Array<{ id: number; ok: boolean; error?: string }>;
    assertEquals(result.map(({ id, ok, error }) => ({ id, ok, error })), [
      ...[1, 2, 3, 4].map((id) => ({ id, ok: false, error: "read-only-device" })),
      { id: 5, ok: true, error: undefined },
    ]);
    assertEquals(messages, ["nav"]);
    assertEquals(binaries, 0);
    const closed = Promise.withResolvers<void>();
    socket.onclose = () => closed.resolve();
    socket.close();
    await closed.promise;
  } finally {
    await f.cleanup();
  }
});
