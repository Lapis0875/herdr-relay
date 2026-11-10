/**
 * One-time WebSocket tickets (DESIGN.md §4): minted over HTTP(S) by an authenticated device (`GET /api/ticket`) and
 * presented once as `/ws?ticket=…`. A ticket is consumed by its first presentation whatever the outcome, expires
 * after 30 s, and is bound to the transport it was minted on (tailnet or loopback).
 */

import type { DeviceIdentity } from "./devices.ts";
import { base64url, randomBytes } from "./secret.ts";

export const TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 256;

export type Via = "tailnet" | "local";

export interface TicketGrant {
  via: Via;
  device: DeviceIdentity;
}

export class TicketBook {
  readonly #now: () => number;
  readonly #tickets = new Map<string, TicketGrant & { expires: number }>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  mint(grant: TicketGrant): string {
    const now = this.#now();
    for (const [t, g] of this.#tickets) if (g.expires <= now) this.#tickets.delete(t);
    if (this.#tickets.size >= MAX_TICKETS) this.#tickets.delete(this.#tickets.keys().next().value!);
    const ticket = base64url(randomBytes(32));
    this.#tickets.set(ticket, { via: grant.via, device: { ...grant.device }, expires: now + TICKET_TTL_MS });
    return ticket;
  }

  /** The grant of an unexpired ticket, removing it; `null` for unknown, used or expired tickets. */
  consume(ticket: string): TicketGrant | null {
    const g = this.#tickets.get(ticket);
    if (!g) return null;
    this.#tickets.delete(ticket);
    return g.expires > this.#now() ? { via: g.via, device: g.device } : null;
  }
}
