/**
 * Pairing codes (DESIGN.md §4): `herdr-relay pair` asks the running bridge (loopback token) for a 6-digit code that
 * lives only in the bridge's memory for 2 minutes and pairs exactly one device. The scope and name are chosen on the
 * Mac when the code is minted; the device cannot pick its own scope. Five wrong codes in a row void every pending
 * code, so guessing needs a new `pair` on the Mac after each five tries.
 */

import type { Scope } from "@herdr-relay/protocol";
import { sameSecret } from "./secret.ts";

export const PAIRING_TTL_MS = 120_000;
export const PAIRING_MAX_FAILURES = 5;
const MAX_PENDING = 8;

/** What redeeming a code grants. */
export interface PairingGrant {
  scope: Scope;
  /** Chosen with `herdr-relay pair --name`; otherwise the device names itself. */
  name: string | null;
}

interface Pending {
  code: string;
  grant: PairingGrant;
  expires: number;
}

/** A uniformly random code `000000`–`999999` (rejection sampling, no modulo bias). */
export function newPairingCode(): string {
  const limit = 2 ** 32 - (2 ** 32 % 1_000_000);
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, "0");
  }
}

export class PairingCodes {
  readonly #now: () => number;
  #pending: Pending[] = [];
  #failures = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Mints a code; the oldest pending code is dropped beyond eight. */
  mint(grant: PairingGrant): { code: string; expiresAt: number } {
    this.#prune();
    const entry = { code: newPairingCode(), grant: { ...grant }, expires: this.#now() + PAIRING_TTL_MS };
    this.#pending.push(entry);
    if (this.#pending.length > MAX_PENDING) this.#pending.shift();
    return { code: entry.code, expiresAt: entry.expires };
  }

  /** The grant of a valid, unexpired, unused code (spaces and dashes ignored); `null` otherwise. Single use. */
  redeem(input: string): PairingGrant | null {
    this.#prune();
    const code = input.replace(/[\s-]/g, "");
    let hit: Pending | null = null;
    if (/^\d{6}$/.test(code)) { for (const p of this.#pending) if (sameSecret(p.code, code)) hit = p; }
    if (!hit) {
      if (++this.#failures >= PAIRING_MAX_FAILURES) {
        this.#pending = [];
        this.#failures = 0;
      }
      return null;
    }
    this.#pending = this.#pending.filter((p) => p !== hit);
    this.#failures = 0;
    return hit.grant;
  }

  /** Codes still redeemable. */
  get pending(): number {
    this.#prune();
    return this.#pending.length;
  }

  #prune(): void {
    const now = this.#now();
    this.#pending = this.#pending.filter((p) => p.expires > now);
  }
}
