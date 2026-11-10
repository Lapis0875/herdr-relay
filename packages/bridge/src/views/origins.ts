/**
 * Origin tokens (DESIGN-v2 §1.5 trust rule, SECURITY S19). A host learns where a call comes from only through the
 * `origin` of the `event`/`command` it was handed, and passes it back on the `emit`/`rpc` that handling leads to. The
 * bridge never hands out a raw session id: every delivery carries a fresh random token, bound to the device session and
 * the socket it was delivered for, the mod folder and the host generation it was delivered to, and valid for
 * {@link ORIGIN_TTL_MS} after delivery (long enough for a handler that awaits RPCs). A token presented by another folder,
 * by a later or earlier host of the same folder, or after its lifetime names no device and counts as `read` — a mod
 * cannot lend itself a scope it was not given for this very interaction, nor carry one over from a previous host or to
 * another folder. The view manager also requires the token's socket to be the session's open one: a disconnected,
 * resumed or revoked session's earlier tokens count as `read` too.
 *
 * Residual (documented, accepted): one host serves every device, so within a folder a mod can replay, for the rest of
 * the token's 30 s, a token that same folder legitimately received from an `act` device — e.g. act for it while
 * handling a `read` device's click that arrives in that window. Closing it would need one host per device.
 */

import type { Origin } from "@herdr-relay/protocol";

/** A host may present an origin token this long after the bridge delivered it. */
export const ORIGIN_TTL_MS = 30_000;

interface Grant {
  session: string;
  /** The socket (`SessionConnection.id`) the token was delivered for. */
  conn: string;
  folder: string;
  generation: number;
  expires: number;
}

/** A presented token's session and socket, or why it names none. */
export type OriginCheck = { ok: true; session: string; conn: string } | { ok: false; reason: string };

export class OriginTokens {
  /** Token → grant, in delivery order (constant lifetime: expiries ascend). */
  readonly #grants = new Map<string, Grant>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(ttlMs = ORIGIN_TTL_MS, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /** A fresh token for one delivery of `session`'s event or command, over socket `conn`, to `folder`'s host `generation`. */
  mint(session: string, conn: string, folder: string, generation: number): Origin {
    const now = this.#now();
    // Expired grants stay one more lifetime so a late use is reported as expired rather than unknown.
    for (const [token, g] of this.#grants) {
      if (g.expires + this.#ttlMs > now) break;
      this.#grants.delete(token);
    }
    const token = `o-${crypto.randomUUID()}`;
    this.#grants.set(token, { session, conn, folder, generation, expires: now + this.#ttlMs });
    return { session: token };
  }

  /** Forgets a token whose delivery failed. */
  revoke(origin: Origin): void {
    this.#grants.delete(origin.session);
  }

  /** Forgets every token of a session (it ended, or its device was revoked). */
  forget(session: string): void {
    for (const [token, g] of this.#grants) if (g.session === session) this.#grants.delete(token);
  }

  /** The session a token names for a message from `folder`'s host `generation`, or why it names none. */
  check(token: string, folder: string, generation: number): OriginCheck {
    const g = this.#grants.get(token);
    if (g === undefined) return { ok: false, reason: "unknown token" };
    if (g.folder !== folder) return { ok: false, reason: "token of another folder" };
    if (g.generation !== generation) return { ok: false, reason: "token of another host generation" };
    if (g.expires <= this.#now()) return { ok: false, reason: "expired token" };
    return { ok: true, session: g.session, conn: g.conn };
  }
}
