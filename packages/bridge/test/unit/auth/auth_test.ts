import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { Auth } from "../../../src/auth/auth.ts";
import { DeviceStore, LOCAL_DEVICE } from "../../../src/auth/devices.ts";
import { type Access, gate } from "../../../src/auth/gate.ts";
import { PAIRING_TTL_MS, PairingCodes } from "../../../src/auth/pairing.ts";
import { LSOF, NETSTAT, PeerCheck, PS } from "../../../src/auth/peer.ts";
import { sha256Hex } from "../../../src/auth/secret.ts";
import { serve } from "../../../src/auth/tailscale.ts";
import { TICKET_TTL_MS, TicketBook } from "../../../src/auth/tickets.ts";
import { ensureStateDir, ensureToken } from "../../../src/auth/token.ts";
import { cli } from "../../../bin/herdr-relay.ts";

const dns = "machine.example.ts.net";
const tailnet = { owner: "owner@example.com", dns };
const config = { port: 7781, token: "local-secret", tailnet, tailnetEnabled: true, extraLoopbackHosts: [] };
const owner = { host: dns, "tailscale-user-login": tailnet.owner };

async function check(headers: Record<string, string>, access: Access = "read", token = false, trusted = true) {
  return await gate({
    method: access === "write" ? "POST" : "GET",
    headers: new Headers(headers),
    access,
    token,
    peerTrusted: () => Promise.resolve(trusted),
  }, config);
}

Deno.test("transport gate rejects spoofed identity, rebinding and cross-site requests", async () => {
  assertEquals(await check(owner), { ok: true, via: "tailnet", login: tailnet.owner });
  assertEquals((await check({ ...owner, "tailscale-user-login": "other@example.com" })).ok, false);
  assertEquals((await check({ ...owner, host: "attacker.example" })).ok, false);
  assertEquals((await check(owner, "read", false, false)).ok, false);
  assertEquals(
    (await check({ host: "attacker.example:7781", authorization: "Bearer local-secret" }, "read", true)).ok,
    false,
  );
  assertEquals(
    (await check({ ...owner, origin: "https://attacker.example", "x-herdr-relay": "1" }, "write")).ok,
    false,
  );
  assertEquals((await check({ ...owner, origin: `https://${dns}` }, "write")).ok, false);
  assertEquals((await check({ ...owner, origin: `https://${dns}`, "x-herdr-relay": "1" }, "write")).ok, true);
  assertEquals((await check({ ...owner, "sec-fetch-site": "cross-site" })).ok, false);
  assertEquals((await check({ host: "127.0.0.1:7781", authorization: "Bearer local-secret" }, "read", true)).ok, true);
  assertEquals((await check({ host: "127.0.0.1:7781", authorization: "Bearer incorrect" }, "read", true)).ok, false);
  assertEquals(
    (await check(
      { host: "127.0.0.1:7781", authorization: "Bearer local-secret", origin: "http://127.0.0.1:7781" },
      "read",
      true,
    )).ok,
    false,
  );
  assertEquals((await check({ host: "127.0.0.1:7781", origin: "http://attacker.example" })).ok, false);
  assertEquals(
    (await gate({
      method: "OPTIONS",
      headers: new Headers(owner),
      access: "read",
      token: false,
      peerTrusted: () => Promise.resolve(true),
    }, config)).ok,
    false,
  );
});

Deno.test("pairing codes expire at two minutes, are single-use, and five wrong tries revoke all", () => {
  let now = 1_000;
  const codes = new PairingCodes(() => now);
  const grant = { scope: "read" as const, name: "phone" };
  const first = codes.mint(grant);
  assertMatch(first.code, /^\d{6}$/);
  assertEquals(first.expiresAt, now + PAIRING_TTL_MS);
  now = first.expiresAt - 1;
  assertEquals(codes.redeem(`${first.code.slice(0, 3)}-${first.code.slice(3)}`), grant);
  assertEquals(codes.redeem(first.code), null);
  const expired = codes.mint(grant);
  now = expired.expiresAt;
  assertEquals(codes.redeem(expired.code), null);
  const locked = new PairingCodes(() => now);
  const pending = locked.mint(grant);
  for (let i = 0; i < 4; i++) assertEquals(locked.redeem("not-a-code"), null);
  assertEquals(locked.pending, 1);
  assertEquals(locked.redeem("not-a-code"), null);
  assertEquals(locked.pending, 0);
  assertEquals(locked.redeem(pending.code), null);
  const fresh = locked.mint(grant);
  assertEquals(locked.redeem(fresh.code), grant);
});

Deno.test("tickets expire, cannot replay, and are bound to their transport", async () => {
  let now = 100;
  const tickets = new TicketBook(() => now);
  const auth = new Auth({
    ...config,
    devices: new DeviceStore(".tmp/nonexistent-auth-test"),
    tickets,
    pairing: null,
    peer: () => Promise.resolve(true),
  });
  const ticket = tickets.mint({ via: "local", device: LOCAL_DEVICE });
  assertEquals((await auth.redeemTicket(ticket, "local")).ok, true);
  assertEquals((await auth.redeemTicket(ticket, "local")).ok, false);
  const cross = tickets.mint({ via: "local", device: LOCAL_DEVICE });
  assertEquals((await auth.redeemTicket(cross, "tailnet")).ok, false);
  assertEquals((await auth.redeemTicket(cross, "local")).ok, false);
  const expired = tickets.mint({ via: "local", device: LOCAL_DEVICE });
  now += TICKET_TTL_MS;
  assertEquals((await auth.redeemTicket(expired, "local")).ok, false);
});

Deno.test("device records retain hashes only with private state and token permissions", async () => {
  const home = await Deno.makeTempDir({ dir: ".tmp", prefix: "auth-home-" });
  const dir = `${home}/.herdr/herdr-relay`;
  try {
    await ensureStateDir(dir);
    const token = await ensureToken(dir);
    const store = new DeviceStore(dir);
    const { device, secret } = await store.add("phone", "read");
    const text = await Deno.readTextFile(store.path);
    assert(!text.includes(secret));
    assertEquals(device.secretHash, await sha256Hex(secret));
    assertStringIncludes(text, device.secretHash);
    assertEquals((await store.findBySecret(secret))?.id, device.id);
    assertEquals(await store.findBySecret("wrong"), null);
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(dir)).mode! & 0o777, 0o700);
      assertEquals((await Deno.stat(store.path)).mode! & 0o777, 0o600);
      assertEquals((await Deno.stat(`${dir}/token`)).mode! & 0o777, 0o600);
    }
    assert(!text.includes(token));
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("peer check fails closed on missing and ambiguous socket ownership", async () => {
  if (Deno.build.os !== "darwin") return;
  const run = (uids: number[]) => (cmd: string, _args: string[]) => {
    if (cmd === NETSTAT) return Promise.resolve("");
    if (cmd === PS) return Promise.resolve("501\n");
    if (cmd === LSOF) {
      return Promise.resolve(uids.map((uid, i) => `p${100 + i}\nu${uid}\nn127.0.0.1:12345->127.0.0.1:7781`).join("\n"));
    }
    return Promise.resolve(null);
  };
  assertEquals(await new PeerCheck(7781, run([501])).trusted(12345), true);
  assertEquals(await new PeerCheck(7781, run([502])).trusted(12345), false);
  assertEquals(await new PeerCheck(7781, run([501, 502])).trusted(12345), false);
  assertEquals(await new PeerCheck(7781, run([])).trusted(12345), false);
});

Deno.test("serve and CLI refuse Funnel without applying a share", async () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return Promise.resolve({
      ok: true,
      out: args[0] === "status"
        ? JSON.stringify({
          BackendState: "Running",
          Self: { UserID: 1, DNSName: `${dns}.` },
          User: { "1": { ID: 1, LoginName: tailnet.owner } },
        })
        : JSON.stringify({ AllowFunnel: { [`${dns}:443`]: true } }),
    });
  };
  const outcome = await serve(run, { port: 7781, dryRun: false });
  assertEquals(outcome.ok, false);
  assertStringIncludes(outcome.message, "Funnel");
  assertEquals(calls, [["status", "--json"], ["serve", "status", "--json"]]);
  const errors: string[] = [];
  assertEquals(
    await cli(["serve"], {
      stateDir: ".tmp/unused",
      port: 7781,
      tailscale: run,
      out: () => {},
      err: (s) => errors.push(s),
    }),
    1,
  );
  assertStringIncludes(errors.join("\n"), "Funnel");
  assertEquals(calls.length, 4);
});
