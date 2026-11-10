import { assert, assertEquals, assertRejects } from "@std/assert";
import type { BridgeMessage } from "@herdr-relay/protocol";
import type { CoreClientEvent, CoreTerminal } from "../../../src/core/mod.ts";
import type { SessionConnection } from "../../../src/server/mod.ts";
import { AlertTracker } from "../../../src/push/alerts.ts";
import { PushService } from "../../../src/push/service.ts";
import { encryptPayload, fromBase64url, isAllowedEndpoint, MAX_PAYLOAD_BYTES } from "../../../src/push/webpush.ts";

const ua = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const sender = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const keys = { p256dh: ua, auth: "BTBZMqHH6r4Tts7J_aSIgg" };
function terminal(address: string, state: string, turn: number): CoreTerminal {
  return {
    address,
    state: "live",
    labels: {},
    argv: [],
    cwd: "",
    created_ms: 0,
    screen: "exact",
    cols: 80,
    rows: 24,
    turn,
    name: address,
    status: { state, msg: "detail" },
  };
}
function reset(reason: "connected" | "reconnected" | "missed", terminals: CoreTerminal[]): CoreClientEvent {
  return { type: "reset", reason, seq: 1, terminals };
}
function status(t: CoreTerminal): CoreClientEvent {
  return {
    type: "event",
    kind: "status",
    seq: 2,
    terminal: t.address,
    machine: null,
    data: { status: t.status, turn: t.turn },
  };
}

Deno.test("alerts deduplicate by address and turn across all ending states", () => {
  for (
    const [kind, title] of [["blocked", "Needs you"], ["done", "Finished"], ["idle", "Finished"], ["error", "Failed"]]
  ) {
    const tracker = new AlertTracker();
    const map = new Map<string, CoreTerminal>();
    const feed = (address: string, state: string, turn: number) => {
      const t = terminal(address, state, turn);
      map.set(address, t);
      return tracker.update(status(t), map);
    };
    tracker.update(reset("connected", [terminal("a", "working", 0), terminal("b", "working", 0)]), map);
    const first = feed("a", kind, 1);
    assertEquals(first.map((a) => [a.kind, a.title, a.terminal, a.turn, a.body]), [[
      kind,
      title,
      "a",
      1,
      "a — detail",
    ]]);
    assertEquals(feed("a", kind, 1), []);
    feed("a", "working", 1);
    assertEquals(feed("a", kind, 1), []);
    assertEquals(feed("b", kind, 1).length, 1);
    feed("a", "working", 1);
    assertEquals(feed("a", kind, 2).length, 1);
  }
});

Deno.test("done to idle never alerts, and reconnect or missed snapshot alerts once", () => {
  const tracker = new AlertTracker();
  const map = new Map<string, CoreTerminal>();
  const working = terminal("a", "working", 0);
  const done = terminal("a", "done", 1);
  const idle = terminal("a", "idle", 1);
  assertEquals(tracker.update(reset("connected", [working]), map), []);
  assertEquals(tracker.update(reset("reconnected", [done]), map).map((a) => a.kind), ["done"]);
  assertEquals(tracker.update(reset("missed", [done]), map), []);
  map.set("a", idle);
  assertEquals(tracker.update(status(idle), map), []);
  tracker.update(reset("missed", [working]), map);
  assertEquals(tracker.update(reset("reconnected", [done]), map), []);
  tracker.update(reset("missed", [terminal("a", "working", 1)]), map);
  assertEquals(tracker.update(reset("missed", [terminal("a", "blocked", 2)]), map).length, 1);
});

Deno.test("RFC 8291 Appendix A encryption matches the complete published record", async () => {
  const pub = fromBase64url(sender);
  const encode = (data: Uint8Array) =>
    btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: encode(pub.subarray(1, 33)),
      y: encode(pub.subarray(33)),
      d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
      ext: true,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const actual = await encryptPayload(fromBase64url("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"), keys, {
    salt: fromBase64url("DGv6ra1nlYgDCS1FRnbzlw"),
    serverKeys: { privateKey, publicKey: pub },
  });
  const header = fromBase64url(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  );
  const ciphertext = fromBase64url("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ");
  assertEquals(actual, new Uint8Array([...header, ...ciphertext]));
  await assertRejects(() => encryptPayload(new Uint8Array(MAX_PAYLOAD_BYTES + 1), keys), RangeError);
});

Deno.test("push endpoints enforce the exact HTTPS host allowlist", () => {
  for (const host of ["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"]) {
    assert(isAllowedEndpoint(`https://${host}/push`));
  }
  for (
    const url of [
      "https://evil.example/push",
      "https://fcm.googleapis.com.evil.example/",
      "http://fcm.googleapis.com/",
      "https://u@fcm.googleapis.com/",
      "https://fcm.googleapis.com:444/",
    ]
  ) assertEquals(isAllowedEndpoint(url), false);
});

Deno.test("visibility mutes deliveries, 410 removes subscription, state files are private", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "push-test-" });
  const sent: string[] = [];
  const messages: BridgeMessage[] = [];
  const conn: SessionConnection = {
    id: "one",
    device: { id: "one", name: "one", scope: "act" },
    via: "local",
    bufferedAmount: 0,
    send: (m) => {
      messages.push(m);
      return true;
    },
    sendBinary: () => true,
    close: () => {},
  };
  const service = new PushService({
    stateDir: dir,
    subject: () => "mailto:test@example.com",
    log: () => {},
    fetch: (input) => {
      sent.push(String(input));
      return Promise.resolve(new Response(null, { status: 410 }));
    },
  });
  const alert = { kind: "done" as const, terminal: "a", turn: 1, title: "Finished", body: "a" };
  try {
    await service.message(conn, { t: "push.sub", id: 1, subscription: { endpoint: "https://evil.example/", keys } });
    assertEquals(messages[0], { t: "ack", id: 1, ok: false, error: "refused", message: "unsupported push service" });
    await service.message(conn, {
      t: "push.sub",
      id: 2,
      subscription: { endpoint: "https://fcm.googleapis.com/test", keys },
    });
    assertEquals(messages[1], { t: "ack", id: 2, ok: true });
    await service.publicKey();
    for (const file of ["push.json", "vapid.json"]) {
      assertEquals((await Deno.stat(`${dir}/${file}`)).mode! & 0o777, 0o600);
    }
    await service.message(conn, { t: "visible", visible: true });
    assertEquals(await service.notify(alert), []);
    assertEquals(sent, []);
    service.drop(conn);
    assertEquals((await service.notify(alert)).map((d) => d.status), [410]);
    assertEquals(sent, ["https://fcm.googleapis.com/test"]);
    assertEquals(service.store.list, []);
    assertEquals(JSON.parse(await Deno.readTextFile(`${dir}/push.json`)).subscriptions, []);
    assertEquals(await service.notify(alert), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
