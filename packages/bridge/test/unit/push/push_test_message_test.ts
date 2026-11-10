import { assert, assertEquals, assertRejects } from "@std/assert";
import type { BridgeMessage } from "@herdr-relay/protocol";
import type { SessionConnection } from "../../../src/server/mod.ts";
import { PushService } from "../../../src/push/service.ts";
import { encryptPayload } from "../../../src/push/webpush.ts";

const keys = {
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};
const endpoint = (path: string) => `https://web.push.apple.com/${path}`;

function connection(id: string, messages: BridgeMessage[], scope: "read" | "act" = "act"): SessionConnection {
  return {
    id,
    device: { id, name: id, scope },
    via: "local",
    bufferedAmount: 0,
    send: (message) => {
      messages.push(message);
      return true;
    },
    sendBinary: () => true,
    close: () => {},
  };
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "push-message-" });
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("push.test sends only to the requesting read-scope device even while visible", async () => {
  await withDir(async (dir) => {
    const sent: string[] = [];
    const logs: string[] = [];
    const messages: BridgeMessage[] = [];
    const read = connection("reader", messages, "read");
    const other = connection("other", []);
    const service = new PushService({
      stateDir: dir,
      subject: () => "mailto:contact@example.com",
      log: (line) => logs.push(line),
      fetch: (input) => {
        sent.push(String(input));
        return Promise.resolve(new Response(null, { status: 201 }));
      },
    });
    await service.message(read, { t: "push.sub", id: 1, subscription: { endpoint: endpoint("reader-secret"), keys } });
    await service.message(other, { t: "push.sub", id: 2, subscription: { endpoint: endpoint("other-secret"), keys } });
    await service.message(other, { t: "visible", visible: true });
    assert(service.muted);
    await service.message(read, { t: "push.test", id: 3 });
    assertEquals(messages, [
      { t: "ack", id: 1, ok: true },
      { t: "ack", id: 3, ok: true, message: "sent to 1 subscription (201)" },
    ]);
    assertEquals(sent, [endpoint("reader-secret")]);
    assert(logs.some((line) => line.includes("web.push.apple.com") && line.includes("201")));
    for (const line of logs) {
      assert(!line.includes("reader-secret") && !line.includes("other-secret"));
      assert(!line.includes(keys.p256dh) && !line.includes(keys.auth));
    }
  });
});

Deno.test("push.test rate limit is per device and expires at five seconds", async () => {
  await withDir(async (dir) => {
    let now = 10_000;
    const messages: BridgeMessage[] = [];
    const first = connection("first", messages);
    const second = connection("second", messages);
    const service = new PushService({
      stateDir: dir,
      subject: () => "mailto:contact@example.com",
      now: () => now,
      log: () => {},
      fetch: () => Promise.resolve(new Response(null, { status: 201 })),
    });
    await service.subscribe({ endpoint: endpoint("first"), keys }, first.device);
    await service.subscribe({ endpoint: endpoint("second"), keys }, second.device);
    await service.message(first, { t: "push.test", id: 1 });
    await service.message(first, { t: "push.test", id: 2 });
    now += 4_001;
    await service.message(first, { t: "push.test", id: 3 });
    await service.message(second, { t: "push.test", id: 4 });
    now += 999;
    await service.message(first, { t: "push.test", id: 5 });
    assertEquals(messages, [
      { t: "ack", id: 1, ok: true, message: "sent to 1 subscription (201)" },
      { t: "ack", id: 2, ok: false, error: "refused", message: "wait 5 s before another test notification" },
      { t: "ack", id: 3, ok: false, error: "refused", message: "wait 1 s before another test notification" },
      { t: "ack", id: 4, ok: true, message: "sent to 1 subscription (201)" },
      { t: "ack", id: 5, ok: true, message: "sent to 1 subscription (201)" },
    ]);
  });
});

Deno.test("push.test reports service responses and removes only expired subscriptions", async () => {
  await withDir(async (dir) => {
    let now = 0;
    let status = 403;
    let reason = "BadJwtToken";
    const logs: string[] = [];
    const messages: BridgeMessage[] = [];
    const conn = connection("device", messages);
    const service = new PushService({
      stateDir: dir,
      subject: () => "mailto:contact@example.com",
      now: () => now,
      log: (line) => logs.push(line),
      fetch: () => Promise.resolve(new Response(JSON.stringify({ reason }), { status })),
    });
    await service.message(conn, { t: "push.test", id: 1 });
    await service.subscribe({ endpoint: endpoint("private-path"), keys }, conn.device);
    now += 5_000;
    await service.message(conn, { t: "push.test", id: 2 });
    assertEquals(service.store.list.length, 1);
    status = 400;
    reason = "x".repeat(200);
    now += 5_000;
    await service.message(conn, { t: "push.test", id: 3 });
    assertEquals(service.store.list.length, 1);
    status = 410;
    reason = "Unregistered";
    now += 5_000;
    await service.message(conn, { t: "push.test", id: 4 });
    assertEquals(service.store.list.length, 0);
    assertEquals(JSON.parse(await Deno.readTextFile(`${dir}/push.json`)).subscriptions, []);
    assertEquals(messages, [
      { t: "ack", id: 1, ok: false, error: "refused", message: "no subscription for this device" },
      { t: "ack", id: 2, ok: false, error: "refused", message: "push service answered 403: BadJwtToken" },
      { t: "ack", id: 3, ok: false, error: "refused", message: `push service answered 400: ${"x".repeat(119)}…` },
      {
        t: "ack",
        id: 4,
        ok: false,
        error: "refused",
        message: "push service answered 410: Unregistered (subscription removed)",
      },
    ]);
    for (const code of [403, 400, 410]) {
      assert(logs.some((line) => line.includes("web.push.apple.com") && line.includes(String(code))));
    }
    for (const line of logs) {
      assert(!line.includes("private-path"));
      assert(!line.includes(keys.p256dh) && !line.includes(keys.auth));
    }
  });
});
Deno.test("push.test sanitizes endpoint paths from network error logs", async () => {
  await withDir(async (dir) => {
    const logs: string[] = [];
    const messages: BridgeMessage[] = [];
    const conn = connection("device", messages);
    const service = new PushService({
      stateDir: dir,
      subject: () => "mailto:contact@example.com",
      log: (line) => logs.push(line),
      fetch: () => Promise.reject(new Error(`request failed for ${endpoint("private-path")}`)),
    });
    await service.subscribe({ endpoint: endpoint("private-path"), keys }, conn.device);
    await service.message(conn, { t: "push.test", id: 1 });
    assert(logs.some((line) => line.includes("web.push.apple.com") && line.includes("failed")));
    for (const line of logs) {
      assert(!line.includes("private-path"));
      assert(!line.includes(keys.p256dh) && !line.includes(keys.auth));
    }
    assertEquals(service.store.list.length, 1);
    assertEquals(messages.length, 1);
  });
});

Deno.test("push encryption respects the 3993-byte plaintext and 4096-byte body boundaries", async () => {
  const record = await encryptPayload(new Uint8Array(3993), keys);
  assertEquals(record.length, 4096);
  await assertRejects(() => encryptPayload(new Uint8Array(3994), keys), RangeError);
});

Deno.test("oversized alert payload is refused without contacting the push service", async () => {
  await withDir(async (dir) => {
    const sent: string[] = [];
    const logs: string[] = [];
    const conn = connection("device", []);
    const service = new PushService({
      stateDir: dir,
      subject: () => "mailto:contact@example.com",
      log: (line) => logs.push(line),
      fetch: (input) => {
        sent.push(String(input));
        return Promise.resolve(new Response(null, { status: 201 }));
      },
    });
    await service.subscribe({ endpoint: endpoint("private-path"), keys }, conn.device);
    assertEquals(
      await service.notify({ kind: "done", terminal: "a", turn: 1, title: "Finished", body: "é".repeat(2000) }),
      [],
    );
    assertEquals(sent, []);
    assert(logs.some((line) => line.includes("bytes; not sent")));
  });
});
