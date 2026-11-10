import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cli } from "../../../bin/herdr-relay.ts";
import { doctor } from "../../../bin/doctor.ts";
import { type LauncherHost, REPO } from "../../../bin/host.ts";
import { bridgeArgs } from "../../../bin/start.ts";
import { resolvePlatform } from "../../../src/platform.ts";
import type { TailscaleRun } from "../../../src/auth/tailscale.ts";

const home = "/Users/example";
const tmp = "/private/tmp/example/";
const platform = (tailscale = "/Applications/Tailscale.app/Contents/MacOS/Tailscale") => {
  const p = resolvePlatform({ os: "darwin", env: () => undefined, isFile: () => false, mayRun: () => false });
  return { ...p, tailscaleBin: tailscale, sandbox: { ...p.sandbox!, available: () => Promise.resolve(true) } };
};
function host(values: Record<string, string>, tailscale?: string): LauncherHost {
  return {
    env: { get: (key) => values[key] },
    platform: () => platform(tailscale),
    repo: REPO,
    arch: "aarch64",
    denoPath: () => "/fake/deno",
    osRelease: () => null,
    exec: (command, args) =>
      Promise.resolve({
        code: 0,
        stdout: command === "deno" && args[0] === "--version"
          ? "deno 2.9.7\n"
          : command === "/usr/bin/sw_vers"
          ? "ProductVersion: 26.4\nBuildVersion: 25E1\n"
          : "",
        stderr: "",
      }),
    runBridge: () => Promise.resolve(0),
  };
}
const noTailscale: TailscaleRun = () => Promise.resolve({ ok: false, out: "not running" });
async function run(args: string[], stateDir: string, h: LauncherHost) {
  const out: string[] = [], err: string[] = [];
  const code = await cli(args, {
    stateDir,
    port: 7781,
    host: h,
    tailscale: noTailscale,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
async function temp() {
  await Deno.mkdir(".tmp", { recursive: true });
  return await Deno.makeTempDir({ dir: await Deno.realPath(".tmp"), prefix: "t44-" });
}
async function tree(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, rel: string) {
    for await (const e of Deno.readDir(path)) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      const full = join(path, e.name);
      if (e.isSymlink) result[name] = `link:${await Deno.readLink(full)}`;
      else if (e.isDirectory) {
        result[name] = "directory";
        await visit(full, name);
      } else result[name] = `file:${Array.from(await Deno.readFile(full)).join(",")}`;
    }
  }
  await visit(dir, "");
  return result;
}

Deno.test("macOS launcher flags match root start task and print-flags", async () => {
  const task = JSON.parse(await Deno.readTextFile(join(REPO, "deno.json"))).tasks.start as string;
  const expanded = task.replaceAll("$HOME", home).replaceAll("$TMPDIR", tmp).split(/\s+/);
  assertEquals(["deno", ...bridgeArgs({ platform: platform(), home, tmpDir: tmp })], expanded);
  const r = await run(["start", "--print-flags"], "/unused", host({ HOME: home, TMPDIR: tmp }));
  assertEquals(r.code, 0);
  assertEquals(r.out.split(" "), expanded);
  assertEquals(r.err, "");
});

Deno.test("launcher app-home and Tailscale overrides change only intended grants", () => {
  const base = bridgeArgs({ platform: platform(), home, tmpDir: tmp });
  const appHome = `${home}/custom-app`;
  const modified = bridgeArgs({ platform: platform("/opt/fake/tailscale"), home, tmpDir: tmp, appHome });
  assertEquals(
    modified,
    base.map((arg) =>
      arg.startsWith("--allow-write=")
        ? arg.replace(`${home}/.config/herdr-app/data/herdr-relay`, `${appHome}/data/herdr-relay`)
        : arg.startsWith("--allow-run=")
        ? arg.replace("/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/fake/tailscale")
        : arg
    ),
  );
  const external = bridgeArgs({ platform: platform(), home, tmpDir: tmp, appHome: "/opt/herdr-app" });
  assertStringIncludes(external.find((a) => a.startsWith("--allow-read="))!, ",/opt/herdr-app");
  assertStringIncludes(external.find((a) => a.startsWith("--allow-write="))!, "/opt/herdr-app/data/herdr-relay");
});

Deno.test("install-mod installs, is idempotent and refuses unsafe replacements without writes", async () => {
  const root = await temp();
  try {
    const app = join(root, "app"), mods = join(app, "mods"), target = join(mods, "herdr-relay-mirror");
    await Deno.mkdir(mods, { recursive: true });
    const h = host({ HOME: root, HERDR_APP_HOME: app });
    const invoke = (args = ["install-mod"]) => run(args, join(root, "state"), h);
    const fresh = await invoke(["install-mod", "--app-home", app]);
    assertEquals(fresh.code, 0);
    assertStringIncludes(fresh.out, "Installed herdr-relay-mirror");
    assertEquals(await tree(target), await tree(join(REPO, "mods/herdr-relay-mirror")));
    const installed = await tree(app);
    const again = await invoke();
    assertEquals(again.code, 0);
    assertStringIncludes(again.out, "already installed");
    assertEquals(await tree(app), installed);
    const manifest = join(target, "mod.json");
    const original = await Deno.readTextFile(manifest);
    await Deno.writeTextFile(manifest, JSON.stringify({ ...JSON.parse(original), version: "9999.0.0" }));
    let before = await tree(app);
    const newer = await invoke();
    assertEquals(newer.code, 1);
    assertStringIncludes(newer.err, "not downgrading");
    assertEquals(await tree(app), before);
    await Deno.writeTextFile(manifest, original);
    await Deno.writeTextFile(join(target, "main.js"), "\n// edited\n", { append: true });
    before = await tree(app);
    const edited = await invoke();
    assertEquals(edited.code, 1);
    assertStringIncludes(edited.err, "differ");
    assertEquals(await tree(app), before);
    await Deno.remove(target, { recursive: true });
    // Git can check out a symlink with the test task's scoped permissions; Deno.symlink requires unscoped grants.
    const repository = join(root, "link-repo");
    await Deno.mkdir(repository);
    const linkContent = join(root, "link-target");
    await Deno.writeTextFile(linkContent, join(REPO, "mods/herdr-relay-mirror"));
    const git = async (args: string[]) => {
      const result = await new Deno.Command("git", {
        args: ["-C", repository, ...args],
        env: { HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      return new TextDecoder().decode(result.stdout).trim();
    };
    await git(["init", "-q"]);
    await git(["config", "core.symlinks", "true"]);
    const object = await git(["hash-object", "-w", linkContent]);
    await git(["update-index", "--add", "--cacheinfo", `120000,${object},herdr-relay-mirror`]);
    await git(["checkout-index", `--prefix=${mods}/`, "herdr-relay-mirror"]);
    assertEquals((await Deno.lstat(target)).isSymlink, true);
    before = await tree(app);
    const linked = await invoke();
    assertEquals(linked.code, 1);
    assertStringIncludes(linked.err, "symbolic link");
    assertEquals(await tree(app), before);
    const other = join(root, "not-app");
    await Deno.mkdir(other);
    const refused = await invoke(["install-mod", "--app-home", other]);
    assertEquals(refused.code, 1);
    assertStringIncludes(refused.err, "not a directory");
    assertEquals(await tree(other), {});
    assertEquals((await invoke(["install-mod", "--app-home", "relative"])).code, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("doctor reports served, Funnel and newer device file with correct exit codes", async () => {
  const root = await temp();
  try {
    const app = join(root, "app"), state = join(root, "state");
    await Deno.mkdir(join(app, "mods"), { recursive: true });
    await Deno.mkdir(state);
    const h = host({ HOME: root, HERDR_APP_HOME: app });
    assertEquals((await run(["install-mod"], state, h)).code, 0);
    let funnel = false;
    const tailscale: TailscaleRun = (args) =>
      Promise.resolve({
        ok: true,
        out: JSON.stringify(
          args[0] === "status"
            ? {
              BackendState: "Running",
              Self: { UserID: 1, DNSName: "mac.example.ts.net." },
              User: { 1: { ID: 1, LoginName: "owner@example.com" } },
            }
            : {
              ...(funnel ? { AllowFunnel: { "mac.example.ts.net:443": true } } : {}),
              Web: { "mac.example.ts.net:443": { Handlers: { "/herdr-relay": { Proxy: "http://127.0.0.1:7781" } } } },
            },
        ),
      });
    const check = async () => {
      const lines: string[] = [];
      const code = await doctor({
        host: h,
        stateDir: state,
        tailscale,
        port: 7781,
        out: (s) => lines.push(s),
        compat: () => Promise.resolve(["compatible"]),
      });
      return { code, text: lines.join("\n") };
    };
    let result = await check();
    assertEquals(result.code, 0);
    assertMatch(result.text, /^ok\s+serve:.*127\.0\.0\.1:7781/m);
    assertMatch(result.text, /^ok\s+devices: 0 paired/m);
    assertMatch(result.text, /^ok\s+mirror:/m);
    assertMatch(result.text, /^0 failed,/m);
    funnel = true;
    result = await check();
    assertEquals(result.code, 1);
    assertMatch(result.text, /^FAIL\s+serve: Funnel is on/m);
    assertMatch(result.text, /^1 failed,/m);
    const file = join(state, "devices.json");
    const content = '{"v":2,"devices":[]}\n';
    await Deno.writeTextFile(file, content);
    result = await check();
    assertEquals(result.code, 1);
    assertMatch(result.text, /^FAIL\s+devices:.*newer herdr-relay/m);
    assertMatch(result.text, /^2 failed,/m);
    assertEquals(await Deno.readTextFile(file), content);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("start reports environment changes and records the new environment", async () => {
  const root = await temp();
  try {
    const state = join(root, "state");
    await Deno.mkdir(state);
    await Deno.writeTextFile(
      join(state, "environment.json"),
      JSON.stringify({
        v: 1,
        recordedAt: "2026-01-01T00:00:00Z",
        os: "darwin",
        arch: "aarch64",
        osVersion: "25.0 (old)",
        deno: { path: "/fake/deno", version: "2.9.6" },
      }),
    );
    const r = await run(["start"], state, host({ HOME: root, TMPDIR: "/tmp" }));
    assertEquals(r.code, 0);
    assertStringIncludes(r.err, "since the last start");
    assertStringIncludes(r.err, "re-run its check");
    assertStringIncludes(r.err, "seatbelt-derive.ts");
    const recorded = JSON.parse(await Deno.readTextFile(join(state, "environment.json")));
    assertEquals(recorded.osVersion, "26.4 (25E1)");
    assertEquals(recorded.deno.version, "2.9.7");
    assert((await run(["start"], state, host({ HOME: root, TMPDIR: "/tmp" }))).err === "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
