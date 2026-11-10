import { assertEquals, assertStringIncludes } from "@std/assert";
import { request as httpRequest } from "node:http";
import { Auth } from "../../../src/auth/auth.ts";
import { DeviceStore, LOCAL_DEVICE } from "../../../src/auth/devices.ts";
import { PairingCodes } from "../../../src/auth/pairing.ts";
import { TicketBook } from "../../../src/auth/tickets.ts";
import { ensureStateDir } from "../../../src/auth/token.ts";
import { startServer } from "../../../src/server/server.ts";

const dns = "machine.example.ts.net";
const owner = "owner@example.com";
const token = "test-loopback-token";
const shell = "<!doctype html><title>shell</title>";
const nav = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
const ws = {
  upgrade: "websocket",
  connection: "Upgrade",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
};

async function fixture() {
  const home = await Deno.makeTempDir({ dir: ".tmp", prefix: "cross-site-nav-" });
  const state = `${home}/state`;
  const webRoot = `${home}/web`;
  await ensureStateDir(state);
  await Deno.mkdir(`${webRoot}/dist`, { recursive: true });
  await Deno.writeTextFile(`${webRoot}/index.html`, shell);
  await Deno.writeTextFile(`${webRoot}/dist/app.js`, "console.log(1)");
  await Deno.writeTextFile(`${webRoot}/sw.js`, "service worker");
  await Deno.mkdir(`${webRoot}/public/img`, { recursive: true });
  await Deno.writeTextFile(`${webRoot}/public/img/x.svg`, "<svg>image</svg>");
  await Deno.writeTextFile(`${webRoot}/public/my font.woff2`, "font data");
  const tickets = new TicketBook();
  let trusted = true;
  let opened = 0;
  const auth = new Auth({
    port: 0,
    token,
    devices: new DeviceStore(state),
    tickets,
    pairing: new PairingCodes(),
    tailnetEnabled: true,
    tailnet: { dns, owner },
    peer: () => Promise.resolve(trusted),
  });
  const server = startServer({
    port: 0,
    auth,
    webRoot,
    sessions: { open: () => void opened++, message() {}, binary() {}, close() {} },
    routes: [
      { prefix: "/assets/", level: "view", handle: () => new Response("asset") },
      { prefix: "/mirror", level: "device", handle: () => new Response("mirror") },
      { prefix: "/push/key", level: "device", handle: () => new Response("key") },
    ],
    log: () => {},
  });
  Object.assign(auth, { port: server.addr.port });
  const local = { host: `127.0.0.1:${server.addr.port}` };
  const tailnet = { host: dns, "tailscale-user-login": owner };
  async function request(path: string, method: string, headers: Record<string, string>) {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; headers: Headers; body: string }>();
    const req = httpRequest({
      hostname: "127.0.0.1",
      port: server.addr.port,
      path: `/herdr-relay${path}`,
      method,
      headers,
    }, (res) => {
      const chunks: Uint8Array[] = [];
      res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const resultHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === "string") resultHeaders.set(key, value);
          else if (value) { for (const part of value) resultHeaders.append(key, part); }
        }
        resolve({ status: res.statusCode ?? 0, headers: resultHeaders, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, headers: new Headers(), body: "" });
    });
    req.on("error", reject);
    req.end();
    return await promise;
  }
  return {
    local,
    tailnet,
    request,
    tickets,
    state,
    setTrusted(value: boolean) {
      trusted = value;
    },
    opened: () => opened,
    async cleanup() {
      await server.shutdown();
      await Deno.remove(home, { recursive: true });
    },
  };
}

Deno.test("cross-site top-level navigation serves only shell pages on loopback and owner tailnet", async () => {
  const f = await fixture();
  try {
    for (const host of [f.local, f.tailnet]) {
      for (const path of ["/", `/?token=${token}`, "/pane/t1", "/pane/t1/", "/index.html", "/index%2ehtml"]) {
        for (const method of ["GET", "HEAD"]) {
          for (const metadata of [nav, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }]) {
            const res = await f.request(path, method, { ...host, ...metadata });
            const context = `${host.host} ${method} ${path} ${JSON.stringify(metadata)}`;
            assertEquals(res.status, 200, context);
            assertEquals(res.body, method === "HEAD" ? "" : shell, context);
            assertStringIncludes(res.headers.get("content-type") ?? "", "text/html", context);
            assertEquals(res.headers.get("set-cookie"), null, context);
          }
        }
      }
    }
    assertEquals(f.opened(), 0);
  } finally {
    await f.cleanup();
  }
});

Deno.test("encoded non-pages never acquire cross-site navigation access", async () => {
  const f = await fixture();
  try {
    const paths = [
      "/app%2ejs",
      "/sw%2ejs",
      "/%61pp.js",
      "/app%252ejs",
      "/sw%252ejs",
      "/%2561pp.js",
      "/assets%2fx.svg",
      "/pane%00x",
      "/a%5cb",
      "/app.js",
      "/sw.js",
      "/dev/widgets",
    ];
    for (const method of ["GET", "HEAD"]) {
      for (const path of paths) {
        assertEquals((await f.request(path, method, { ...f.local, ...nav })).status, 403, `${method} ${path}`);
      }
      for (const path of ["/app%2ejs", "/sw%2ejs"]) {
        assertEquals(
          (await f.request(path, method, { ...f.tailnet, ...nav })).status,
          403,
          `tailnet ${method} ${path}`,
        );
      }
    }
  } finally {
    await f.cleanup();
  }
});

Deno.test("same-origin requests resolve encoded assets once and reject unsafe paths", async () => {
  const f = await fixture();
  try {
    const headers = {
      ...f.local,
      authorization: `Bearer ${token}`,
      "x-herdr-relay": "1",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
    };
    for (
      const [path, body] of [
        ["/app.js", "console.log(1)"],
        ["/sw.js", "service worker"],
        ["/img/x.svg", "<svg>image</svg>"],
        ["/my%20font.woff2", "font data"],
        ["/%61pp.js", "console.log(1)"],
        ["/app%2ejs", "console.log(1)"],
      ]
    ) {
      const res = await f.request(path, "GET", headers);
      assertEquals(res.status, 200, path);
      assertEquals(res.body, body, path);
    }
    for (const path of ["/assets%2fx.svg", "/app%252ejs", "/pane//t1"]) {
      assertEquals((await f.request(path, "GET", headers)).status, 404, path);
    }
  } finally {
    await f.cleanup();
  }
});

Deno.test("cross-site navigation never grants API, resource, frame or WebSocket access", async () => {
  const f = await fixture();
  try {
    const bearer = { authorization: `Bearer ${token}`, "x-herdr-relay": "1" };
    const cases: Array<{ path: string; method?: string; headers: Record<string, string> }> = [
      { path: "/", headers: { ...nav, "sec-fetch-dest": "iframe" } },
      { path: "/", headers: { ...nav, "sec-fetch-dest": "frame" } },
      { path: "/", headers: { ...nav, origin: "https://evil.example" } },
      { path: "/", method: "POST", headers: nav },
      ...["cors", "no-cors", "same-origin"].map((mode) => ({
        path: "/",
        headers: { ...nav, "sec-fetch-mode": mode },
      })),
      ...[
        "/api/hello",
        "/api/ticket",
        "/api/unknown",
        "/assets/x.svg",
        "/mirror",
        "/push/key",
        "/app.js",
        "/bundle.js",
        "/sw.js",
        "/manifest.webmanifest",
      ].map((path) => ({
        path,
        headers: { ...nav, ...bearer },
      })),
      ...[
        "/api/hello",
        "/api/ticket",
        "/api/unknown",
        "/assets/x.svg",
        "/mirror",
        "/push/key",
        "/app.js",
        "/bundle.js",
        "/sw.js",
        "/manifest.webmanifest",
      ].map((path) => ({
        path,
        headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", ...bearer },
      })),
    ];
    for (const host of [f.local, f.tailnet]) {
      for (const c of cases) {
        const res = await f.request(c.path, c.method ?? "GET", { ...host, ...c.headers });
        assertEquals(res.status, 403, `${host.host} ${c.method ?? "GET"} ${c.path} ${JSON.stringify(c.headers)}`);
      }
      for (
        const metadata of [
          { "sec-fetch-site": "cross-site", "sec-fetch-mode": "websocket", "sec-fetch-dest": "websocket" },
          nav,
        ]
      ) {
        const ticket = f.tickets.mint({ via: "local", device: LOCAL_DEVICE });
        const res = await f.request(`/ws?ticket=${ticket}`, "GET", { ...host, ...ws, ...metadata });
        assertEquals(res.status, 403, `${host.host} websocket ${JSON.stringify(metadata)}`);
      }
      for (const path of ["/", "/api/hello", "/ws", "/assets/x.svg", "/mirror", "/push/key", "/app.js"]) {
        assertEquals(
          (await f.request(path, "OPTIONS", { ...host, ...nav })).status,
          403,
          `${host.host} OPTIONS ${path}`,
        );
      }
    }
    assertEquals(f.opened(), 0);
  } finally {
    await f.cleanup();
  }
});

Deno.test("cross-site navigation still checks owner, host and trusted peer", async () => {
  const f = await fixture();
  try {
    assertEquals(
      (await f.request("/", "GET", { ...f.tailnet, ...nav, "tailscale-user-login": "other@example.com" })).status,
      403,
    );
    assertEquals((await f.request("/", "GET", { ...f.tailnet, ...nav, host: "evil.example" })).status, 421);
    assertEquals((await f.request("/", "GET", { ...f.local, ...nav, host: "evil.example" })).status, 421);
    f.setTrusted(false);
    assertEquals((await f.request("/", "GET", { ...f.tailnet, ...nav })).status, 403);
  } finally {
    await f.cleanup();
  }
});

Deno.test("a token in a cross-site navigation does not authenticate subsequent cross-site requests", async () => {
  const f = await fixture();
  try {
    const page = await f.request(`/?token=${token}`, "GET", { ...f.local, ...nav });
    assertEquals(page.status, 200);
    assertEquals(page.body, shell);
    assertEquals(page.headers.get("set-cookie"), null);
    const headers = { ...f.local, authorization: `Bearer ${token}`, "x-herdr-relay": "1" };
    const crossSite = await f.request("/api/ticket", "GET", { ...headers, ...nav });
    assertEquals(crossSite.status, 403);
    const sameOrigin = await f.request("/api/ticket", "GET", {
      ...headers,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    });
    assertEquals(sameOrigin.status, 200);
    assertStringIncludes(sameOrigin.body, '"ticket"');
    assertEquals(f.opened(), 0);
    const devicesExist = await Deno.stat(`${f.state}/devices.json`).then(() => true, (error) => {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    });
    assertEquals(devicesExist, false);
  } finally {
    await f.cleanup();
  }
});
