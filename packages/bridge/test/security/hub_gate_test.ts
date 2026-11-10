import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { delay } from "@std/async";
import { join } from "@std/path";
import type { PolicyLogRecord, Rpc, Toast } from "@herdr-relay/protocol";
import { HerdrSource } from "../../src/herdr/source.ts";
import { ProfileSet } from "../../src/policy/profiles.ts";
import type { ResolvedOrigin } from "../../src/views/mod.ts";

const TOKEN = "synthetic-hub-secret-token";
const COCKPIT = "lstack-herdr-cockpit";
const readDevice: ResolvedOrigin = { session: "read-device", scope: "read", connected: true };
const actDevice: ResolvedOrigin = { session: "act-device", scope: "act", connected: true };
const downgraded: ResolvedOrigin = { session: "disconnected-device", scope: "read", connected: false };
const line = (op: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ op, token: TOKEN, frontend: "app", ...fields }) + "\n";
const act = (app: string, action: string, args: unknown[] = []) => line("act", { app, action, args });

class FakeHub {
  readonly listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  readonly connections: { bytes: string }[] = [];
  readonly open = new Set<Deno.Conn>();
  readonly serving: Promise<void>;
  get port() {
    return (this.listener.addr as Deno.NetAddr).port;
  }
  constructor() {
    this.serving = (async () => {
      try {
        for await (const conn of this.listener) {
          this.open.add(conn);
          const record = { bytes: "" };
          this.connections.push(record);
          void (async () => {
            const decoder = new TextDecoder();
            const encoder = new TextEncoder();
            const buf = new Uint8Array(65536);
            let pending = "";
            try {
              for (;;) {
                const n = await conn.read(buf);
                if (n === null) break;
                const text = decoder.decode(buf.subarray(0, n), { stream: true });
                record.bytes += text;
                pending += text;
                let end: number;
                while ((end = pending.indexOf("\n")) !== -1) {
                  pending = pending.slice(end + 1);
                  await conn.write(encoder.encode(JSON.stringify({ note: "hub ok" }) + "\n"));
                }
              }
            } catch { /* socket closed during teardown */ }
            this.open.delete(conn);
            try {
              conn.close();
            } catch { /* already closed */ }
          })();
        }
      } catch { /* listener closed during teardown */ }
    })();
  }
  all() {
    return this.connections.map((c) => c.bytes).join("");
  }
  async close() {
    for (const conn of this.open) {
      try {
        conn.close();
      } catch { /* already closed */ }
    }
    this.listener.close();
    await this.serving;
  }
}

async function setup() {
  await Deno.mkdir(".tmp", { recursive: true });
  const root = await Deno.realPath(await Deno.makeTempDir({ dir: ".tmp", prefix: "hub-gate-" }));
  const appHome = join(root, "app");
  const cache = join(root, "cache");
  const state = join(root, "state");
  const userProfiles = join(state, "profiles");
  for (const dir of [appHome, cache, userProfiles]) await Deno.mkdir(dir, { recursive: true });
  await Deno.chmod(userProfiles, 0o700);
  const hub = new FakeHub();
  await Deno.writeTextFile(join(cache, "hub.json"), JSON.stringify({ port: hub.port, token: TOKEN }));
  await Deno.writeTextFile(join(appHome, "cockpit.json"), JSON.stringify({ cache, home: root }));
  const generic = join(userProfiles, "generic.json");
  await Deno.writeTextFile(
    generic,
    JSON.stringify({ id: "generic-net", folders: ["generic"], net: { hubPortFrom: "cockpit.json" } }),
  );
  await Deno.chmod(generic, 0o600);
  const profiles = await ProfileSet.load({ userDir: userProfiles, log: () => {} });
  const records: PolicyLogRecord[] = [];
  const toasts: { session: string; toast: Toast }[] = [];
  const source = await HerdrSource.start({
    appHome,
    home: root,
    core: {
      state: "closed" as const,
      session: null,
      terminals: new Map(),
      on: () => () => {},
      docGet: () => Promise.reject(new Error("no core in this test")),
    },
    paths: { home: root, appHome, state, run: root, repo: root },
    env: { PATH: join(root, "no-bin") },
    profiles,
    policyLog: (record) => records.push(record),
    toast: (session, toast) => {
      if (session !== readDevice.session && session !== actDevice.session) return false;
      toasts.push({ session, toast });
      return true;
    },
    log: () => {},
  });
  let id = 0;
  const call = (folder: string, method: Rpc["method"], args: unknown[], origin: ResolvedOrigin | null) =>
    source.rpc({ folder, generation: 1 }, { t: "rpc", id: ++id, copy: `${folder}:b`, method, args } as Rpc, origin);
  const connect = async (folder = COCKPIT) =>
    await call(folder, "net.connect", ["127.0.0.1", hub.port], null) as string;
  const write = (conn: string, text: string, origin: ResolvedOrigin | null, folder = COCKPIT) =>
    call(folder, "net.write", [conn, text], origin);
  const read = async (conn: string) => {
    const b64 = await call(COCKPIT, "net.read", [conn, 65536], null) as string | null;
    return b64 === null ? null : new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
  };
  return {
    hub,
    records,
    toasts,
    connect,
    write,
    read,
    async close() {
      source.close();
      await hub.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test("cockpit hub write gate through HerdrSource and a fake loopback hub", async (t) => {
  const env = await setup();
  const { hub, records, toasts, connect, write, read } = env;
  try {
    await t.step("read devices cannot fork or resume and receive a toast", async () => {
      for (
        const [request, title] of [
          [act("agents", "fork", [{ terminal: "app:t1", place: "tab" }]), "Forking an agent needs the Herdr window"],
          [act("home", "resume", ["h1"]), "Resuming agents needs the Herdr window"],
        ]
      ) {
        const c = await connect();
        await assertRejects(() => write(c, request, readDevice), Error, title);
        await delay(30);
        assertEquals(hub.all(), "");
        assertEquals(toasts.at(-1), { session: readDevice.session, toast: { t: "toast", title, level: "warning" } });
        await assertRejects(() => write(c, line("subscribe"), null), Error, "no such connection");
      }
      const c = await connect();
      await assertRejects(() => write(c, act("inbox", "merge", [{ pr: "x" }]), readDevice), Error, "act scope");
      assertEquals(toasts.at(-1)?.toast.title, "Read-only device");
      assertEquals(toasts.at(-1)?.toast.body, "inbox merge needs act scope");
    });
    await t.step("downgraded origin receives no toast", async () => {
      const before = toasts.length;
      const c = await connect();
      await assertRejects(() => write(c, act("agents", "seen", [{ terminal: "t1" }]), downgraded));
      await delay(30);
      assertEquals(hub.all(), "");
      assertEquals(toasts.length, before);
    });
    await t.step("act device can send agents seen", async () => {
      const c = await connect();
      const request = act("agents", "seen", [{ terminal: "t1" }]);
      await write(c, request, actDevice);
      assertEquals(await read(c), '{"note":"hub ok"}\n');
      assertEquals(hub.connections.at(-1)?.bytes, request);
    });
    await t.step("structural actions are refused and toasted for an act device", async () => {
      const requests = [
        act("agents", "fork", [{ terminal: "t1", place: "tab" }]),
        act("agents", "fork", [{ place: "right" }]),
        act("palette", "fork", [{}, {}]),
        act("runbook", "focus_session", [{ $handoff: "x-1" }]),
        act("home", "resume", []),
        act("inbox", "fix_ci", ["https://example.com/pr/1"]),
        act("inbox", "start", [{ id: "T-1" }]),
        act("runbook", "run_step", [{ $book: "b" }, { n: 1 }]),
        act("runbook", "talk", [{ $book: "b" }]),
        act("routines", "run", ["daily"]),
        act("routines", "resume", ["daily"]),
        act("routines", "constructor"),
        act("routines", "edit", ["daily"]),
        act("routines", "open_worktree", ["daily", "r1"]),
        act("routines", "cleanup", ["daily", "r1"]),
        act("inbox", "remove_worktree", ["/tmp/wt"]),
        line("go", { target: { app: "inbox", key: "k" } }),
      ];
      for (const request of requests) {
        const before = hub.all();
        const c = await connect();
        await assertRejects(() => write(c, request, actDevice), Error, "needs the Herdr window");
        await delay(30);
        assertEquals(hub.all(), before);
        assertStringIncludes(toasts.at(-1)!.toast.title, "needs the Herdr window");
        assertEquals(toasts.at(-1)!.session, actDevice.session);
        await assertRejects(() => write(c, line("subscribe"), null), Error, "no such connection");
      }
    });
    await t.step("origin-less subscribe and pr_merge fetch reach the hub", async () => {
      for (
        const request of [
          line("subscribe", { views: ["agents"], docs: [], notify: true }),
          line("fetch", { kind: "pr_merge", args: { pr: "x" } }),
        ]
      ) {
        const c = await connect();
        await write(c, request, null);
        assertEquals(await read(c), '{"note":"hub ok"}\n');
        assertEquals(hub.connections.at(-1)?.bytes, request);
      }
    });
    await t.step("fragmented requests and atomic multi-line writes", async () => {
      const allowed = act("agents", "seen", [{ terminal: "t2" }]);
      const c = await connect();
      await write(c, allowed.slice(0, 17), actDevice);
      await delay(30);
      assertEquals(hub.connections.at(-1)?.bytes, "");
      await write(c, allowed.slice(17), actDevice);
      await read(c);
      assertEquals(hub.connections.at(-1)?.bytes, allowed);
      const forbidden = act("agents", "fork", [{ place: "tab" }]);
      const c2 = await connect();
      await write(c2, forbidden.slice(0, 20), actDevice);
      await assertRejects(() => write(c2, forbidden.slice(20), actDevice), Error, "needs the Herdr window");
      await delay(30);
      assertEquals(hub.connections.at(-1)?.bytes, "");
      for (
        const [payload, origin] of [[allowed + forbidden, actDevice], [
          line("subscribe") + act("home", "resume"),
          readDevice,
        ]] as const
      ) {
        const conn = await connect();
        await assertRejects(() => write(conn, payload, origin));
        await delay(30);
        assertEquals(hub.connections.at(-1)?.bytes, "");
      }
      const c3 = await connect();
      const both = line("view", { name: "home", args: null }) + allowed;
      await write(c3, both, actDevice);
      await delay(30);
      assertEquals(hub.connections.at(-1)?.bytes, both);
      for (const request of [act("routines", "pause", ["daily", true]), act("routines", "looked")]) {
        const conn = await connect();
        await write(conn, request, actDevice);
        await read(conn);
        assertEquals(hub.connections.at(-1)?.bytes, request);
      }
    });
    await t.step("invalid requests close the connection and send nothing", async () => {
      for (
        const bad of [line("drop_tables"), "not json\n", "[1,2]\n", "\n", '{"x":1}\n', "x".repeat(1024 * 1024 + 1)]
      ) {
        const before = hub.all();
        const c = await connect();
        await assertRejects(() => write(c, bad, actDevice));
        await assertRejects(() => write(c, line("subscribe"), null), Error, "no such connection");
        await delay(30);
        assertEquals(hub.all(), before);
      }
    });
    await t.step("open_url is intercepted only for a connected device before any hub request", async () => {
      const c = await connect();
      await write(c, act("inbox", "open_url", ["https://example.com/pr/1"]), readDevice);
      assertEquals(toasts.at(-1), {
        session: readDevice.session,
        toast: {
          t: "toast",
          title: "Open link",
          body: "https://example.com/pr/1",
          level: "info",
          action: { open: "https://example.com/pr/1" },
        },
      });
      assertEquals(await read(c), '{"note":"opened https://example.com/pr/1","pending":{},"refreshing":{}}\n');
      await delay(30);
      assertEquals(hub.connections.at(-1)?.bytes, "");
      const c2 = await connect();
      await assertRejects(
        () => write(c2, act("inbox", "open_url", ["file:///etc/passwd"]), actDevice),
        Error,
        "http(s)",
      );
      const c3 = await connect();
      await assertRejects(() => write(c3, act("inbox", "open_url", ["https://example.com"]), null), Error, "no device");
      const c4 = await connect();
      await write(c4, line("subscribe"), actDevice);
      await assertRejects(
        () => write(c4, act("inbox", "open_url", ["https://example.com"]), actDevice),
        Error,
        "another request",
      );
    });
    await t.step("generic default writes require an act device", async () => {
      for (const origin of [readDevice, null]) {
        await delay(30); // let earlier steps' admitted writes reach the fake hub before the snapshot
        const before = hub.all();
        const c = await connect("generic");
        await assertRejects(() => write(c, line("subscribe"), origin, "generic"), Error, "act scope");
        await delay(30);
        assertEquals(hub.all(), before);
      }
      const c = await connect("generic");
      await write(c, "raw-no-newline", actDevice, "generic");
      await delay(30);
      assertEquals(hub.connections.at(-1)?.bytes, "raw-no-newline");
    });
    await t.step("policy records include net decisions and profiles but never the token", () => {
      const net = records.filter((record) => record.method === "net.write");
      assert(net.length > 10);
      assert(net.every((record) => record.rule === "net" && !!record.profile));
      assert(net.some((record) => record.decision === "intercept" && record.argv.includes("https://example.com/pr/1")));
      const fork = net.find((record) => record.argv.join(" ") === "act agents fork");
      assertEquals(fork?.decision, "refuse");
      assertEquals(fork?.profile, "lstack-herdr");
      assertEquals(net.find((record) => record.argv.join(" ") === "act inbox merge")?.session, readDevice.session);
      assertEquals(
        net.find((record) => record.argv.join(" ") === "act routines run")?.reason,
        "Running a routine needs the Herdr window",
      );
      assert(!JSON.stringify(records).includes(TOKEN), "hub token leaked into policy log");
    });
  } finally {
    await env.close();
  }
});
