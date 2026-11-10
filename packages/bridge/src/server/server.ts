/**
 * The bridge's HTTP + WebSocket server (DESIGN-v2 T10): `Deno.serve` on `127.0.0.1:<port>` only, reached from the
 * tailnet through `tailscale serve --set-path /herdr-relay` and locally at `http://127.0.0.1:<port>/herdr-relay/`.
 *
 * Routes (mount-relative; see `auth/auth.ts` for the levels):
 * - `GET /api/hello` (`owner`): who is asking, whether this device is paired, whether pairing is on.
 * - `GET /api/ticket` (`device`, plus `X-Herdr-Relay: 1`): a one-time WebSocket ticket, valid 30 s.
 * - `POST /api/pair/code` (loopback token only): mint a 6-digit pairing code (`herdr-relay pair`).
 * - `POST /api/pair` (tailnet owner, write checks): redeem a code → device record + httpOnly cookie.
 * - `GET /ws?ticket=…` (`shell` gate with socket checks, then the ticket): the device session.
 * - extension {@link Route}s (`device`/`view` level), then the app shell (`shell` level, GET/HEAD; only its page,
 *   `index.html` per `shellFile`, gets `navigate` access — the one thing a cross-site top-level navigation may load,
 *   see `auth/gate.ts`).
 *
 * Every 2 s the device list is re-read. A tailnet device that had a socket this run and is no longer paired — or every
 * such device while the list cannot be read (fail closed) — is revoked once: the session layer's `revokeDevice` (when
 * it has one) ends its sessions at once — also those waiting for a resume — whatever close code the client's socket
 * ends up reporting, then its remaining sockets are closed (1008 "device revoked"). Only after a successful read does
 * the session layer's `retainDevices` (when it has one) drop the device-local state (layout profiles, D12) of every
 * device the list no longer names, the loopback identity excepted: an unreadable list never deletes it.
 */

import { PROTOCOL_VERSION, type Scope } from "@herdr-relay/protocol";
import {
  type Access,
  type Auth,
  cleanDeviceName,
  CUSTOM_HEADER,
  deviceCookie,
  type DeviceIdentity,
  deviceView,
  LOCAL_DEVICE,
  PAIRING_TTL_MS,
  TICKET_TTL_MS,
  type Via,
} from "../auth/mod.ts";
import { MOUNT } from "../config.ts";
import { type SessionConnection, type SessionHandler, WsConnection } from "./connection.ts";
import { BodyError, json, readJsonObject, routePath, secured, text } from "./http.ts";
import { serveShell, shellFile } from "./shell.ts";

/** A route added by another bridge module (mod assets, the mirror endpoint), matched by mount-relative prefix. */
export interface Route {
  prefix: string;
  /** `device`: paired device or loopback token; `view`: paired device or token-free loopback, GET/HEAD only. */
  level: "device" | "view";
  handle(req: Request, ctx: RouteContext): Response | Promise<Response>;
}

export interface RouteContext {
  /** Mount-relative path. */
  path: string;
  via: Via;
  login: string | null;
  device: DeviceIdentity;
}

/**
 * The session layer. `revokeDevice` (the view manager's) ends every session of a device at once — on a confirmed
 * revocation, and fail closed while the device list is unreadable — and keeps its device-local state; `retainDevices`,
 * called only after a successful read, drops the device-local state of devices `paired` does not name.
 */
export interface RevocableSessions extends SessionHandler {
  revokeDevice?(deviceId: string): void;
  retainDevices?(paired: (deviceId: string) => boolean): void;
}

export interface ServerOptions {
  port: number;
  auth: Auth;
  /** The session layer; without it `/ws` answers 503 after authentication. */
  sessions?: RevocableSessions;
  routes?: readonly Route[];
  /** `packages/web`; `null` serves no app shell. */
  webRoot: string | null;
  log?: (line: string) => void;
  onListen?: (addr: Deno.NetAddr) => void;
}

export interface BridgeServer {
  readonly addr: Deno.NetAddr;
  /** Open device sockets that sent `hello` or are waiting for it. */
  readonly connections: ReadonlySet<SessionConnection>;
  readonly finished: Promise<void>;
  /** Closes every socket (1001) and stops listening. */
  shutdown(): Promise<void>;
}

const REVOKE_SWEEP_MS = 2_000;
const READS: Readonly<Record<string, true>> = { GET: true, HEAD: true };

export function startServer(o: ServerOptions): BridgeServer {
  const { auth } = o;
  const log = o.log ?? ((line: string) => console.error(`herdr-relay: ${line}`));
  const conns = new Set<WsConnection>();
  // Tailnet devices that had a socket this run (sessions may outlive it while they wait for a resume).
  const tracked = new Set<string>();

  const refuse = (req: Request, path: string, status: number, why: string): Response => {
    log(`${status} ${req.method} ${path}: ${why}`);
    return text(why, status);
  };
  const unpaired = { status: 401, why: "this device is not paired" };

  async function handle(req: Request, remotePort: number): Promise<Response> {
    const url = new URL(req.url);
    const path = routePath(url.pathname);
    if (path === null) return new Response(null, { status: 308, headers: { location: `${MOUNT}/${url.search}` } });
    const access: Access = READS[req.method] ? "read" : "write";
    const tailnet = req.headers.has("tailscale-user-login");
    const no = (r: { status: number; why: string }) => refuse(req, path, r.status, r.why);
    if (req.method === "OPTIONS") return no({ status: 403, why: "no cross-site requests" });

    if (path === "/ws") return await upgrade(req, url, path, remotePort);

    if (path === "/api/hello") {
      if (req.method !== "GET") return no({ status: 405, why: "GET only" });
      const r = await auth.check(req, remotePort, "owner", access);
      if (!r.ok) return no(r);
      const dns = auth.tailnet?.dns;
      return json({
        v: PROTOCOL_VERSION,
        via: r.identity.via,
        login: r.identity.login,
        paired: r.identity.device !== null,
        device: r.identity.device,
        pairing: auth.pairing !== null,
        url: dns && auth.tailnetEnabled ? `https://${dns}${MOUNT}/` : null,
      });
    }

    if (path === "/api/ticket") {
      if (req.method !== "GET") return no({ status: 405, why: "GET only" });
      if (req.headers.get(CUSTOM_HEADER) !== "1") return no({ status: 403, why: `missing ${CUSTOM_HEADER}` });
      const r = await auth.check(req, remotePort, "device", access);
      if (!r.ok) return no(r);
      const device = r.identity.device;
      if (!device) return no(unpaired);
      const ticket = auth.tickets.mint({ via: r.identity.via, device });
      return json({ ticket, expiresIn: TICKET_TTL_MS / 1000 });
    }

    if (path === "/api/pair/code") {
      if (req.method !== "POST") return no({ status: 405, why: "POST only" });
      if (tailnet) return no({ status: 403, why: "pairing codes are minted on the Mac: herdr-relay pair" });
      const r = await auth.check(req, remotePort, "owner", access);
      if (!r.ok) return no(r);
      if (!auth.pairing) return no({ status: 403, why: "pairing is disabled (HERDR_RELAY_DEV=insecure-no-sandbox)" });
      let body: Record<string, unknown>;
      try {
        body = await readJsonObject(req);
      } catch (e) {
        return no({ status: 400, why: e instanceof BodyError ? e.message : "bad body" });
      }
      const scope: Scope | null = body.scope === undefined || body.scope === "read"
        ? "read"
        : body.scope === "act"
        ? "act"
        : null;
      if (!scope) return no({ status: 400, why: "scope must be read or act" });
      const name = body.name === undefined ? null : cleanDeviceName(body.name);
      if (body.name !== undefined && name === null) return no({ status: 400, why: "name is empty" });
      const { code, expiresAt } = auth.pairing.mint({ scope, name });
      const dns = auth.tailnet?.dns;
      return json({
        code,
        scope,
        name,
        expiresAt: new Date(expiresAt).toISOString(),
        ttlSeconds: PAIRING_TTL_MS / 1000,
        url: dns ? `https://${dns}${MOUNT}/` : null,
      });
    }

    if (path === "/api/pair") {
      if (req.method !== "POST") return no({ status: 405, why: "POST only" });
      if (!tailnet) return no({ status: 403, why: "pairing is for tailnet devices; loopback clients use the token" });
      const r = await auth.check(req, remotePort, "owner", access);
      if (!r.ok) return no(r);
      if (!auth.pairing) return no({ status: 403, why: "pairing is disabled" });
      let body: Record<string, unknown>;
      try {
        body = await readJsonObject(req);
      } catch (e) {
        return no({ status: 400, why: e instanceof BodyError ? e.message : "bad body" });
      }
      const grant = typeof body.code === "string" ? auth.pairing.redeem(body.code) : null;
      if (!grant) return no({ status: 403, why: "wrong or expired code" });
      const name = grant.name ?? cleanDeviceName(body.name) ?? "device";
      const { device, secret } = await auth.devices.add(name, grant.scope);
      log(`paired device ${device.id} (${device.name}, ${device.scope})`);
      return json({ device: deviceView(device) }, 200, { "set-cookie": deviceCookie(secret, MOUNT) });
    }

    if (path.startsWith("/api/")) {
      const r = await auth.check(req, remotePort, "owner", access);
      return r.ok ? text("not found", 404) : no(r);
    }

    for (const route of o.routes ?? []) {
      if (!path.startsWith(route.prefix)) continue;
      if (route.level === "view" && access !== "read") return no({ status: 405, why: "GET only" });
      const r = await auth.check(req, remotePort, route.level, access);
      if (!r.ok) return no(r);
      const { via, login, device } = r.identity;
      if (!device) return no(unpaired);
      return await route.handle(req, { path, via, login, device });
    }

    // The canonical shell file (shell.ts, decoded once) decides both the access and what is served: only the app's
    // page (`index.html`, for `/` and client routes) gets `navigate`, the one access a cross-site top-level navigation
    // may have (gate.ts); `/api/*`, `/ws`, extension routes and the bundle's other files stay same-site only.
    const file = access === "read" ? shellFile(path) : null;
    const shellAccess: Access = file?.page ? "navigate" : access;
    const r = await auth.check(req, remotePort, "shell", shellAccess);
    if (!r.ok) return no(r);
    if (access !== "read") return no({ status: 405, why: "GET only" });
    if (!o.webRoot || !file) return text("not found", 404);
    return await serveShell(o.webRoot, file, req.method === "HEAD", shellAccess);
  }

  async function upgrade(req: Request, url: URL, path: string, remotePort: number): Promise<Response> {
    const no = (r: { status: number; why: string }) => refuse(req, path, r.status, r.why);
    if (req.method !== "GET" || (req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return no({ status: 400, why: "expected a WebSocket upgrade" });
    }
    const r = await auth.check(req, remotePort, "shell", "socket");
    if (!r.ok) return no(r);
    if (!o.sessions) return no({ status: 503, why: "this bridge has no session handler" });
    const t = await auth.redeemTicket(url.searchParams.get("ticket"), r.identity.via);
    if (!t.ok) return no(t);
    const { socket, response } = Deno.upgradeWebSocket(req);
    const conn = new WsConnection(socket, {
      id: crypto.randomUUID(),
      device: t.device,
      via: r.identity.via,
      handler: o.sessions,
      log,
      onGone: (c) => conns.delete(c),
    });
    conns.add(conn);
    if (conn.via === "tailnet") tracked.add(conn.device.id);
    return response;
  }

  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: o.port,
    onListen: (addr) => o.onListen?.(addr),
    onError: (e) => {
      log(`request failed: ${e instanceof Error ? e.message : String(e)}`);
      return text("internal error", 500);
    },
  }, async (req, info) => secured(await handle(req, info.remoteAddr.port)));

  const sweep = setInterval(async () => {
    await auth.devices.refresh();
    // Synchronous from here on: an overlapping sweep cannot revoke the same device twice.
    const readable = auth.devices.error === null;
    for (const id of [...tracked]) {
      if (auth.devices.has(id)) continue;
      tracked.delete(id);
      log(
        `device ${id} ${readable ? "revoked" : "unverifiable (the device list cannot be read)"}; ending its sessions`,
      );
      try {
        o.sessions?.revokeDevice?.(id);
      } catch (e) {
        log(`revoking device ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (const c of conns) if (c.via === "tailnet" && c.device.id === id) c.close(1008, "device revoked");
    }
    // An unreadable list pairs no device (fail closed above) but must not delete the state of devices still paired.
    if (!readable) return;
    try {
      o.sessions?.retainDevices?.((id) => id === LOCAL_DEVICE.id || auth.devices.has(id));
    } catch (e) {
      log(`dropping the state of unpaired devices failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, REVOKE_SWEEP_MS);
  Deno.unrefTimer(sweep);

  return {
    addr: server.addr,
    connections: conns,
    finished: server.finished,
    async shutdown() {
      clearInterval(sweep);
      for (const c of conns) c.close(1001, "bridge shutting down");
      await server.shutdown();
    },
  };
}
