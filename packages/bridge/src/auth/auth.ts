/**
 * The bridge's request authentication: the transport gate (`gate.ts`) followed by the device check (DESIGN.md §4
 * "Device pairing", the second factor). Tailnet requests carry a paired device's cookie; loopback requests act as
 * {@link LOCAL_DEVICE} with the token. Routes pick one level:
 *
 * | level    | tailnet                         | loopback                   |
 * |----------|---------------------------------|----------------------------|
 * | `shell`  | owner (app shell, pairing page) | no token (app shell)       |
 * | `owner`  | owner; device optional          | token                      |
 * | `device` | owner + paired device           | token                      |
 * | `view`   | owner + paired device           | no token (read-only GETs)  |
 *
 * WebSockets are authenticated by a one-time ticket (`redeemTicket`) after a `shell`-level gate with `socket` access.
 */

import { DEVICE_COOKIE, readCookie } from "./cookie.ts";
import { type DeviceIdentity, type DeviceStore, deviceView, LOCAL_DEVICE } from "./devices.ts";
import { type Access, gate } from "./gate.ts";
import type { PairingCodes } from "./pairing.ts";
import type { TailnetIdentity } from "./tailscale.ts";
import type { TicketBook, Via } from "./tickets.ts";

export type AuthLevel = "shell" | "owner" | "device" | "view";

export interface Identity {
  via: Via;
  /** `Tailscale-User-Login` (tailnet only). */
  login: string | null;
  /** `null` only for `shell`/`owner` requests without a paired device. */
  device: DeviceIdentity | null;
}

export type AuthResult = { ok: true; identity: Identity } | { ok: false; status: number; why: string };

export interface AuthOptions {
  port: number;
  token: string;
  devices: DeviceStore;
  tickets: TicketBook;
  /** `null` when pairing is disabled (`insecure-no-sandbox`). */
  pairing: PairingCodes | null;
  /** `false` in `insecure-no-sandbox`: every tailnet request is refused. */
  tailnetEnabled: boolean;
  /** Loopback host names besides `127.0.0.1`/`localhost` (dev: `10.0.2.2`). */
  extraLoopbackHosts?: readonly string[];
  /** tailscaled-or-this-user check of the connection from a remote port (`PeerCheck.trusted`). */
  peer: (remotePort: number) => Promise<boolean>;
  tailnet?: TailnetIdentity | null;
}

export class Auth {
  /** Refreshed by the bridge from `tailscale status --json`. */
  tailnet: TailnetIdentity | null;
  readonly port: number;
  readonly devices: DeviceStore;
  readonly tickets: TicketBook;
  readonly pairing: PairingCodes | null;
  readonly tailnetEnabled: boolean;
  readonly #token: string;
  readonly #extraHosts: readonly string[];
  readonly #peer: (remotePort: number) => Promise<boolean>;

  constructor(o: AuthOptions) {
    this.port = o.port;
    this.#token = o.token;
    this.devices = o.devices;
    this.tickets = o.tickets;
    this.pairing = o.pairing;
    this.tailnetEnabled = o.tailnetEnabled;
    this.#extraHosts = o.extraLoopbackHosts ?? [];
    this.#peer = o.peer;
    this.tailnet = o.tailnet ?? null;
  }

  async check(req: Request, remotePort: number, level: AuthLevel, access: Access): Promise<AuthResult> {
    const pass = await gate({
      method: req.method,
      headers: req.headers,
      access,
      token: level === "owner" || level === "device",
      peerTrusted: () => this.#peer(remotePort),
    }, {
      port: this.port,
      token: this.#token,
      tailnet: this.tailnet,
      tailnetEnabled: this.tailnetEnabled,
      extraLoopbackHosts: this.#extraHosts,
    });
    if (!pass.ok) return pass;
    if (pass.via === "local") {
      return { ok: true, identity: { via: "local", login: null, device: level === "shell" ? null : LOCAL_DEVICE } };
    }
    const secret = readCookie(req.headers.get("cookie"), DEVICE_COOKIE);
    const record = secret ? await this.devices.findBySecret(secret) : null;
    if (!record && (level === "device" || level === "view")) {
      return { ok: false, status: 401, why: "this device is not paired (run `herdr-relay pair` on the Mac)" };
    }
    return { ok: true, identity: { via: "tailnet", login: pass.login, device: record ? deviceView(record) : null } };
  }

  /** The device a WebSocket ticket was minted for, consuming the ticket; it must match the transport it is used on. */
  async redeemTicket(
    ticket: string | null,
    via: Via,
  ): Promise<{ ok: true; device: DeviceIdentity } | { ok: false; status: number; why: string }> {
    const grant = ticket ? this.tickets.consume(ticket) : null;
    if (!grant) return { ok: false, status: 401, why: "invalid, used or expired ticket" };
    if (grant.via !== via) return { ok: false, status: 403, why: "ticket minted on another transport" };
    if (via === "tailnet") {
      await this.devices.refresh();
      if (!this.devices.has(grant.device.id)) return { ok: false, status: 403, why: "device revoked" };
    }
    return { ok: true, device: grant.device };
  }
}
