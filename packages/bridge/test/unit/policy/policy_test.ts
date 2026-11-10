import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  decideExec,
  decideHerdrAppDo,
  type ExecRequest,
  type PolicyContext,
  policyExec,
  policyReadTextFile,
  PolicyRefusal,
  ReadRoots,
  resolveAsset,
  resolveDirUnderRoots,
  USER_DECISIONS,
} from "../../../src/policy/mod.ts";

const listing =
  'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
const picture = (fetch: string, size: string) =>
  `mkdir -p "$(dirname "$1")" && { [ -s "$1" ] || ${fetch}; } && ${size}`;
const remotePicture = picture('curl -fsSL --max-time 20 -o "$1" "$2"', 'sips -g pixelWidth -g pixelHeight "$1"');
const localPicture = picture('cp "$2" "$1"', '{ file -b "$1" || true; }');

async function fixture(fn: (ctx: PolicyContext, dir: string) => void | Promise<void>) {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "policy-" });
  try {
    const root = await Deno.realPath(dir);
    const app = join(root, "app");
    for (
      const path of [
        "mods/lstack-herdr-cockpit",
        "mods/lstack-herdr/components",
        "data/cockpit/show",
        "repo/.git",
        "icons",
      ]
    ) {
      await Deno.mkdir(join(app, path), { recursive: true });
    }
    for (
      const path of [
        "mods/lstack-herdr-cockpit/lh-scan.mjs",
        "mods/lstack-herdr/components/lh-scan.mjs",
        "mods/lstack-herdr/sync.mjs",
        "input.png",
        "icons/a.svg",
      ]
    ) {
      await Deno.writeTextFile(join(app, path), "test");
    }
    const roots = await ReadRoots.resolve(app, [{ path: app, kind: "dir" }]);
    const ctx: PolicyContext = {
      roots,
      paths: { home: root, appHome: app, state: join(root, "state"), run: join(root, "run"), repo: root },
      loadedFolders: new Set(["lstack-herdr", "lstack-herdr-cockpit"]),
      cockpit: null,
      env: { PATH: "/bin" },
      log: () => {},
    };
    await fn(ctx, root);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function request(command: string, argv: string[], extra: Partial<ExecRequest> = {}): ExecRequest {
  return { folder: "files", method: "exec", command, argv, scope: "act", session: "device", ...extra };
}
async function plan(ctx: PolicyContext, command: string, argv: string[], extra: Partial<ExecRequest> = {}) {
  return await decideExec(ctx, request(command, argv, extra));
}
async function refused(ctx: PolicyContext, command: string, argv: string[], extra: Partial<ExecRequest> = {}) {
  assertEquals((await plan(ctx, command, argv, extra)).kind, "refuse", `${command} ${argv.join(" ")}`);
}

Deno.test("E1 known loaded scans, arguments and scope of folders", () =>
  fixture(async (ctx) => {
    for (const script of ["mods/lstack-herdr-cockpit/lh-scan.mjs", "mods/lstack-herdr/components/lh-scan.mjs"]) {
      const path = join(ctx.paths.appHome, script);
      const p = await plan(ctx, "node", [path, "tree", "a", "b", "c"]);
      assertEquals(p.kind, "script");
      if (p.kind === "script") assertEquals(p.run.profile, "lh-scan");
      await refused(ctx, "node", [path, "tree", "-x"]);
      await refused(ctx, "node", [path, "tree", "a", "b", "c", "d"]);
      await refused({ ...ctx, loadedFolders: new Set() }, "node", [path, "tree"]);
    }
  }));
Deno.test("E2 sync defaults to refusal and requires act even when enabled", () =>
  fixture(async (ctx) => {
    const args = [join(ctx.paths.appHome, "mods/lstack-herdr/sync.mjs"), "--json"];
    await refused(ctx, "node", args);
    const enabled = { ...ctx, decisions: { ...USER_DECISIONS, syncFromDevices: true } };
    assertEquals((await plan(enabled, "node", args)).kind, "sync");
    await refused(enabled, "node", args, { scope: "read" });
    await refused(enabled, "node", [args[0], "--home=/tmp"]);
  }));
Deno.test("E3 node flags and foreign scripts are refused", () =>
  fixture(async (ctx) => {
    for (
      const args of [["-e", "1"], ["--loader", "x"], ["/tmp/foreign.js"], [
        join(ctx.paths.appHome, "mods/other/lh-scan.mjs"),
        "tree",
      ]]
    ) await refused(ctx, "node", args);
  }));
Deno.test("E4 git read controls and dangerous options", () =>
  fixture(async (ctx) => {
    const options = { options: { cwd: join(ctx.paths.appHome, "repo") } };
    for (const sub of ["rev-parse", "status", "diff", "log", "show", "branch", "ls-files"]) {
      const p = await plan(ctx, "git", ["-c", "core.fsmonitor=false", sub], options);
      assertEquals(p.kind, "spawn", sub);
      if (p.kind === "spawn" && ["diff", "log", "show"].includes(sub)) {
        assertEquals(p.spec.args.includes("--no-ext-diff"), true);
        assertEquals(p.spec.args.includes("--no-textconv"), true);
      }
    }
    assertEquals((await plan(ctx, "git", ["--version"])).kind, "spawn");
    for (
      const args of [
        ["-c", "alias.x=!echo PWNED", "x"],
        ["-ccore.editor=evil", "status"],
        ["--exec-path=/tmp", "status"],
        ["diff", "--ext-diff"],
        ["diff", "--textconv"],
        ["diff", "--no-index"],
        ["status", "--output=/tmp/x"],
        ["push"],
        ["branch", "new-branch"],
      ]
    ) await refused(ctx, "git", args, options);
    await refused(ctx, "git", ["-C", "/", "status"]);
    await refused(ctx, "git", ["status"]);
    await refused(ctx, "git", ["status"], { options: { cwd: ctx.paths.appHome, on: "remote" } });
  }));
Deno.test("E5 git writes require act, repository root and exact forms", () =>
  fixture(async (ctx) => {
    const options = { options: { cwd: join(ctx.paths.appHome, "repo") } };
    for (const args of [["add", "-A"], ["commit", "-m", "message"]]) {
      assertEquals((await plan(ctx, "git", args, options)).kind, "spawn");
      await refused(ctx, "git", args, { ...options, scope: "read" });
      await refused({ ...ctx, decisions: { ...USER_DECISIONS, gitCommitFromActDevices: false } }, "git", args, options);
    }
    await refused(ctx, "git", ["commit", "-m", "message", "--amend"], options);
    await refused(ctx, "git", ["add", "-A"], { options: { cwd: ctx.paths.appHome } });
    await refused(ctx, "git", ["add", "-A"], { ...options, session: null });
  }));
Deno.test("E6 hc machine listing only", () =>
  fixture(async (ctx) => {
    assertEquals((await plan(ctx, "hc", ["machine", "ls", "--json"])).rule, "E6");
    assertEquals((await plan(ctx, "hc", ["machine", "ls", "--json"])).kind, "spawn");
    await refused(ctx, "hc", ["machine", "ls", "--json", "extra"]);
  }));
Deno.test("E7 hc read forms only", () =>
  fixture(async (ctx) => {
    for (
      const args of [
        ["ls", "--json"],
        ["terminal", "list", "--json"],
        ["terminal", "get", "id", "--json"],
        ["schema"],
        ["--version"],
      ]
    ) {
      assertEquals((await plan(ctx, "", args, { method: "hc" })).kind, "spawn");
    }
    for (
      const args of [["connect"], ["kill", "id"], ["terminal", "run", "id"], ["doc", "set", "x"], [
        "terminal",
        "get",
        "--bad",
        "--json",
      ]]
    ) await refused(ctx, "", args, { method: "hc" });
  }));
Deno.test("E8 structural herdr-app calls always refused", () =>
  fixture(async (ctx) => {
    await refused(ctx, "env", [
      `HERDR_APP_HOME=${ctx.paths.appHome}`,
      "/home/user/.local/bin/herdr-app",
      "do",
      "pane.split",
      "{}",
    ]);
    await refused(ctx, "herdr-app", ["do", "pane.split", "{}"]);
  }));
Deno.test("E9 passthrough requires act and classified command", () =>
  fixture((ctx) => {
    const req = { folder: "files", name: "theme.select", commandClass: "passthrough" as const, scope: "act" as const };
    const p = decideHerdrAppDo(ctx, req);
    assertEquals(p.kind, "spawn");
    if (p.kind === "spawn") assertEquals(p.spec.args, ["do", "theme.select", "{}"]);
    assertEquals(decideHerdrAppDo(ctx, { ...req, scope: "read" }).kind, "refuse");
    assertEquals(decideHerdrAppDo(ctx, { ...req, commandClass: "structural" }).kind, "refuse");
  }));
Deno.test("E10 cockpit env exact allowlist and forbidden injection keys", () =>
  fixture(async (ctx, root) => {
    const bin = join(root, "cockpit");
    await Deno.writeTextFile(bin, "");
    const c = { ...ctx, cockpit: { bin, home: root, env: { CUSTOM: "ok", DYLD_INSERT_LIBRARIES: "evil" } } };
    const args = [
      `HOME=${root}`,
      `HERDR_APP_HOME=${ctx.paths.appHome}`,
      "COCKPIT_FRONTEND=app",
      "CUSTOM=ok",
      bin,
      "hub",
      "start",
    ];
    assertEquals((await plan(c, "env", args)).kind, "spawn");
    const denied = await policyExec(c, request("env", args));
    assertEquals(denied.decision, "refuse");
    assertEquals(denied.rule, "E10");
    assertEquals(denied.result.code, 126);
    for (
      const assignment of [
        "DYLD_INSERT_LIBRARIES=evil",
        "LD_PRELOAD=evil",
        "NODE_OPTIONS=evil",
        "PATH=/tmp",
        "CUSTOM=wrong",
        "UNLISTED=x",
      ]
    ) {
      await refused(c, "env", [assignment, bin, "hub", "start"]);
    }
    await refused(c, "env", [`HOME=${root}`, bin, "hub", "stop"]);
  }));
Deno.test("E11 links are intercepted on device, not spawned", () =>
  fixture(async (ctx) => {
    const p = await plan(ctx, "open", ["https://example.com/path"]);
    assertEquals(p.kind, "open-url");
    if (p.kind === "open-url") assertEquals(p.url, "https://example.com/path");
    for (
      const args of [["file:///etc/passwd"], ["javascript:alert(1)"], ["https://example.com", "extra"]]
    ) await refused(ctx, "open", args);
    await refused({ ...ctx, decisions: { ...USER_DECISIONS, openUrlOnDevice: false } }, "open", [
      "https://example.com",
    ]);
  }));
Deno.test("E12 non-Mac openers refused", () =>
  fixture(async (ctx) => {
    for (const command of ["xdg-open", "cmd", "powershell"]) await refused(ctx, command, ["https://example.com"]);
  }));
Deno.test("E13 Mac editor and application launch refused", () =>
  fixture(async (ctx) => {
    await refused(ctx, "code", ["-g", "file:1"]);
    await refused(ctx, "code", ["--folder-uri", "file:///tmp"]);
    await refused(ctx, "open", ["-a", "TextEdit", ctx.paths.appHome]);
  }));
Deno.test("E14 pinned listing literal and roots", () =>
  fixture(async (ctx) => {
    assertEquals((await plan(ctx, "sh", ["-c", listing, "files", ctx.paths.appHome])).kind, "listing");
    await refused(ctx, "sh", ["-c", listing + " ", "files", ctx.paths.appHome]);
    await refused(ctx, "sh", ["-c", listing, "files", "/etc"]);
  }));
Deno.test("E15 pinned picture literals, source and destination boundaries", () =>
  fixture(async (ctx) => {
    const dest = join(ctx.paths.appHome, "data/cockpit/show/picture");
    for (
      const [literal, src] of [[remotePicture, "https://example.com/image.png"], [
        localPicture,
        join(ctx.paths.appHome, "input.png"),
      ]]
    ) {
      const p = await plan(ctx, "sh", ["-c", literal, "sh", dest, src]);
      assertEquals(p.kind, "script");
      if (p.kind === "script") assertEquals(p.run.profile, "picture");
    }
    await refused(ctx, "sh", ["-c", remotePicture, "sh", dest, "file:///etc/passwd"]);
    await refused(ctx, "sh", ["-c", remotePicture, "sh", join(ctx.paths.appHome, "outside"), "https://example.com/a"]);
    await refused(ctx, "sh", ["-c", localPicture, "sh", dest, "/etc/passwd"]);
    await refused(ctx, "sh", ["-c", remotePicture + " ", "sh", dest, "https://example.com/a"]);
  }));
Deno.test("E16 arbitrary programs and shell refused", () =>
  fixture(async (ctx) => {
    for (
      const [command, args] of [["cat", ["/etc/passwd"]], ["sh", ["-c", "echo x"]], ["env", ["/bin/sh"]], ["curl", [
        "https://example.com",
      ]], ["/usr/bin/git", ["--version"]]] as const
    ) await refused(ctx, command, [...args]);
  }));

Deno.test("read policy roots, missing files, symlink escapes and size boundary", () =>
  fixture(async (ctx) => {
    const app = ctx.paths.appHome;
    await Deno.writeTextFile(join(app, "limit"), "x".repeat(1024 * 1024));
    await Deno.writeTextFile(join(app, "large"), "x".repeat(1024 * 1024 + 1));
    assertEquals(await policyReadTextFile(ctx.roots, "missing"), null);
    assertEquals((await policyReadTextFile(ctx.roots, "limit"))?.length, 1024 * 1024);
    for (const path of ["../secret", "large"]) {
      await assertRejects(() => policyReadTextFile(ctx.roots, path), PolicyRefusal);
    }
    const fixtureApp = await Deno.realPath("packages/bridge/test/unit/policy/fixtures/app");
    const fixtureRoots = await ReadRoots.resolve(fixtureApp, [{ path: fixtureApp, kind: "dir" }]);
    await assertRejects(() => policyReadTextFile(fixtureRoots, "link"), PolicyRefusal);
    await assertRejects(() => resolveDirUnderRoots(ctx.roots, "/", "watchFolder"), PolicyRefusal);
  }));
Deno.test("static assets reject traversal and symlinks", () =>
  fixture(async (ctx) => {
    const asset = await resolveAsset(ctx.roots, "icons/a.svg");
    assertEquals(asset?.contentType, "image/svg+xml");
    for (
      const path of ["icons/../input.png", "../secret.svg", "/icons/a.svg", "icons\\a.svg", "mods/a/main.js"]
    ) assertEquals(await resolveAsset(ctx.roots, path), null);
    const fixtureApp = await Deno.realPath("packages/bridge/test/unit/policy/fixtures/app");
    const fixtureRoots = await ReadRoots.resolve(fixtureApp, [{ path: fixtureApp, kind: "dir" }]);
    assertEquals(await resolveAsset(fixtureRoots, "icons/link.svg"), null);
  }));
Deno.test("refusals and intercepted URLs return and log without spawning", () =>
  fixture(async (ctx) => {
    const records: Array<{ decision: string; rule?: string }> = [];
    const c = { ...ctx, log: (record: { decision: string; rule?: string }) => records.push(record) };
    const result = await policyExec(c, request("cat", ["secret"]));
    assertEquals(result.result.code, 126);
    assertEquals(result.result.stdout, "");
    assertStringIncludes(result.result.stderr, "herdr-relay:");
    const open = await policyExec(c, request("open", ["https://example.com"]));
    assertEquals(open.openUrl, "https://example.com/");
    assertEquals(records.map((r) => [r.rule, r.decision]), [["E16", "refuse"], ["E11", "intercept"]]);
  }));
