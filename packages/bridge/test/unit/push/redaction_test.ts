import { assert, assertEquals } from "@std/assert";
import type { Ack, BridgeMessage } from "@herdr-relay/protocol";
import type { SessionConnection } from "../../../src/server/mod.ts";
import { apnsIdOf, PushService, redactDiagnostic, TEST_INTERVAL_MS } from "../../../src/push/mod.ts";

const P256DH = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const APPLE_TOKEN = "QGuQyavXutnMbzz2fB1uJ2ToKr6yfRmQnmQ_aU3Nl8XNbX3Z-Kt9wVhOsTq";
const APPLE = `https://web.push.apple.com/${APPLE_TOKEN}`;
const FCM_ID = "dpH5lCsTSSM";
const FCM_TOKEN = "APA91bHqjZxJ7uR3wzJ_Lx4cGk2Q";
const FCM = `https://fcm.googleapis.com/fcm/send/${FCM_ID}:${FCM_TOKEN}`;
const UUID = "5E6A1F2B-0000-4000-8000-ABCDEF012345";
const std = (b64url: string) => b64url.replaceAll("-", "+").replaceAll("_", "/");

/** Strings that must never reach a log line or an ack; any 10 consecutive characters of one count as a leak. */
const SECRETS = [APPLE_TOKEN, P256DH, AUTH, std(P256DH), std(AUTH), FCM_ID, FCM_TOKEN];

function assertNoLeak(text: string): void {
  for (const secret of SECRETS) {
    for (let at = 0; at + 10 <= secret.length; at++) {
      const window = secret.slice(at, at + 10);
      assert(!text.includes(window), `"${window}" of a subscription secret leaked into: ${text}`);
    }
  }
}

/** How a push service might echo the subscription back. */
const ECHOES: Record<string, string> = {
  endpoint: APPLE,
  path: `/${APPLE_TOKEN}`,
  token: APPLE_TOKEN,
  "percent-encoded endpoint": encodeURIComponent(APPLE),
  "JSON-escaped endpoint": APPLE.replaceAll("/", "\\/"),
  "endpoint with query": `${APPLE}?p256dh=${P256DH}`,
  p256dh: P256DH,
  auth: AUTH,
  "padded auth": `${AUTH}==`,
  "base64 p256dh": std(P256DH),
  "base64 auth": `${std(AUTH)}==`,
  markup: `<a href="${APPLE}">${APPLE_TOKEN}</a> auth ${AUTH}`,
};

interface Harness {
  dir: string;
  service: PushService;
  logs: string[];
  acks: BridgeMessage[];
  conn: SessionConnection;
  /** The next answer of the injected push service. */
  answer: (respond: () => Response | Promise<Response>) => void;
  /** Sends `push.test` (past the rate limit) and returns its ack. */
  test: () => Promise<Ack>;
}

async function harness(endpoint: string): Promise<Harness> {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "push-redaction-" });
  const logs: string[] = [];
  const acks: BridgeMessage[] = [];
  let clock = 0;
  let respond: () => Response | Promise<Response> = () => new Response(null, { status: 201 });
  const service = new PushService({
    stateDir: dir,
    subject: () => "https://mac.example.ts.net",
    log: (line) => logs.push(line),
    now: () => clock,
    fetch: () => Promise.resolve(respond()),
  });
  const device = { id: "ipad", name: "ipad", scope: "read" as const };
  const conn: SessionConnection = {
    id: "socket",
    device,
    via: "tailnet",
    bufferedAmount: 0,
    send: (m) => {
      acks.push(m);
      return true;
    },
    sendBinary: () => true,
    close: () => {},
  };
  assertEquals(await service.subscribe({ endpoint, keys: { p256dh: P256DH, auth: `${AUTH}==` } }, device), null);
  let id = 0;
  return {
    dir,
    service,
    logs,
    acks,
    conn,
    answer: (next) => (respond = next),
    test: async () => {
      clock += TEST_INTERVAL_MS;
      await service.message(conn, { t: "push.test", id: ++id });
      const ack = acks.at(-1);
      assert(ack?.t === "ack" && ack.id === id);
      return ack;
    },
  };
}

Deno.test("JSON and plain-text reasons that echo the endpoint, path or keys leak into neither log nor ack", async () => {
  const h = await harness(APPLE);
  try {
    for (const [name, echo] of Object.entries(ECHOES)) {
      const bodies: [string, string][] = [
        ["JSON reason", JSON.stringify({ reason: `bad ${echo}` })],
        ["JSON message", JSON.stringify({ code: 400, message: `bad ${echo}` })],
        ["JSON without a named field", JSON.stringify({ detail: `bad ${echo}` })],
        ["JSON with escaped slashes", `{"reason":"bad ${echo.replaceAll("/", "\\/")}"}`],
        ["plain text", `bad ${echo}`],
        ["cut-off JSON", `{"reason":"bad ${echo.replaceAll("/", "\\/")}`],
      ];
      for (const [kind, body] of bodies) {
        h.answer(() => new Response(body, { status: 400, headers: { "apns-id": UUID } }));
        const ack = await h.test();
        const log = h.logs.at(-1)!;
        assertEquals(ack.ok, false, `${name} / ${kind}`);
        assert(ack.message?.startsWith("push service answered 400: "), `${name} / ${kind}: ${ack.message}`);
        assert(log.startsWith("web.push.apple.com 400 "), `${name} / ${kind}: ${log}`);
        assertNoLeak(ack.message!);
        assertNoLeak(log);
      }
    }
    // Redaction comes before truncation: a long body still ends up short and clean.
    h.answer(() => new Response(`${"x".repeat(100)} ${APPLE} ${P256DH}`, { status: 400 }));
    const ack = await h.test();
    assert(ack.message!.length <= "push service answered 400: ".length + 120, ack.message);
    assertNoLeak(ack.message!);
    for (const line of h.logs) assertNoLeak(line);
  } finally {
    await Deno.remove(h.dir, { recursive: true });
  }
});

Deno.test("an FCM reason echoing the instance id or token alone is redacted", async () => {
  const h = await harness(FCM);
  try {
    for (const echo of [FCM, FCM_ID, FCM_TOKEN, `${FCM_ID}:${FCM_TOKEN}`, `fcm/send/${FCM_ID}`]) {
      h.answer(() => new Response(JSON.stringify({ error: { code: 404, message: `gone ${echo}` } }), { status: 404 }));
      const ack = await h.test();
      assertNoLeak(ack.message!);
      assertNoLeak(h.logs.at(-1)!);
      assert(h.logs.at(-1)!.startsWith("fcm.googleapis.com 404 "), h.logs.at(-1));
      // 404 dropped it; subscribe again for the next round.
      await h.service.subscribe({ endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH } }, h.conn.device);
    }
  } finally {
    await Deno.remove(h.dir, { recursive: true });
  }
});

Deno.test("an alert's log line is redacted the same way", async () => {
  const h = await harness(APPLE);
  try {
    h.answer(() => new Response(JSON.stringify({ reason: `BadDeviceToken for ${APPLE} ${AUTH}` }), { status: 400 }));
    const deliveries = await h.service.notify({ kind: "done", terminal: "t1", turn: 1, title: "Finished", body: "t1" });
    assertEquals(deliveries.map((d) => d.status), [400]);
    assertEquals(deliveries[0].reason, "BadDeviceToken for web.push.apple.com [key]");
    assertEquals(h.logs.at(-1), "web.push.apple.com 400 BadDeviceToken for web.push.apple.com [key]");
  } finally {
    await Deno.remove(h.dir, { recursive: true });
  }
});

Deno.test("apns-id reaches the log only as a UUID", async () => {
  const h = await harness(APPLE);
  try {
    h.answer(() => new Response(null, { status: 201, headers: { "apns-id": UUID } }));
    assertEquals(await h.test(), { t: "ack", id: 1, ok: true, message: "sent to 1 subscription (201)" });
    assertEquals(h.logs.at(-1), `web.push.apple.com 201 ${UUID}`);
    for (const forged of [APPLE_TOKEN, APPLE, `${UUID} ${AUTH}`, "<script>", P256DH.slice(0, 36)]) {
      h.answer(() => new Response(null, { status: 201, headers: { "apns-id": forged } }));
      assertEquals((await h.test()).ok, true);
      assertEquals(h.logs.at(-1), "web.push.apple.com 201");
    }
    assertEquals(apnsIdOf(` ${UUID.toLowerCase()} `), UUID.toLowerCase());
    assertEquals(apnsIdOf(null), undefined);
  } finally {
    await Deno.remove(h.dir, { recursive: true });
  }
});

Deno.test("a delivery error quoting the endpoint and keys is redacted", async () => {
  const h = await harness(APPLE);
  try {
    h.answer(() => {
      throw new TypeError(`error sending request for url (${APPLE}?auth=${AUTH}): connection refused`);
    });
    const ack = await h.test();
    assertEquals(ack.ok, false);
    assertEquals(
      ack.message,
      "push service unreachable: error sending request for url (web.push.apple.com?auth=[key]): " +
        "connection refused",
    );
    assertNoLeak(ack.message!);
    assertNoLeak(h.logs.at(-1)!);
  } finally {
    await Deno.remove(h.dir, { recursive: true });
  }
});

Deno.test("redactDiagnostic: protocol words stay, URLs and long tokens go", () => {
  const secrets = { endpoint: APPLE, keys: { p256dh: P256DH, auth: AUTH } };
  for (
    const word of [
      "BadJwtToken",
      "TooManyProviderTokenUpdates",
      "DeviceTokenNotForTopic",
      "UnrelatedKeyIdInToken",
      "INVALID_ARGUMENT",
      "THIRD_PARTY_AUTH_ERROR",
      "Content-Type must be application/octet-stream",
      "Request did not validate No such subscription",
    ]
  ) assertEquals(redactDiagnostic(word, secrets), word);
  assertEquals(redactDiagnostic("see https://autopush.example/docs#errors now", secrets), "see [url] now");
  assertEquals(redactDiagnostic("see https%3A%2F%2Fexample.com%2Fx now", secrets), "see [url] now");
  assertEquals(
    redactDiagnostic("id 0123456789abcdef0123 and deadbeefdeadbeefdead", secrets),
    "id [redacted] and [redacted]",
  );
  assertEquals(redactDiagnostic(`id ${UUID}`, secrets), "id [redacted]");
  assertEquals(
    redactDiagnostic("jwt eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwcyJ9.c2lnbmF0dXJlLWJ5dGVz", secrets),
    "jwt [redacted].[redacted].[redacted]",
  );
  assertEquals(
    redactDiagnostic("short words and Base64ish abc_DEF stay", secrets),
    "short words and Base64ish abc_DEF stay",
  );
  assertEquals(redactDiagnostic(`at ${APPLE} with ${P256DH}`, secrets), "at web.push.apple.com with [key]");
});
