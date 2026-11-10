import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { decideExec, FolderPolicies, policyContext, ProfileSet, ReadRoots } from "../../../src/policy/mod.ts";

Deno.test("documented lstack-shape profile enables E1/E10/E14/E15 but not E2 or unsafe variants", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "lstack-shape-" });
  try {
    const home = await Deno.realPath(dir);
    const app = join(home, "app");
    const components = join(app, "mods/lstack-herdr/components");
    const pictureDir = join(app, "data/cockpit/show");
    const users = join(home, "profiles");
    await Deno.mkdir(components, { recursive: true });
    await Deno.mkdir(pictureDir, { recursive: true });
    await Deno.mkdir(users);
    await Deno.copyFile("fixtures/probe-mods/lstack-shape/components/lh-scan.mjs", join(components, "lh-scan.mjs"));
    await Deno.copyFile("fixtures/probe-mods/lstack-shape/sync.mjs", join(app, "mods/lstack-herdr/sync.mjs"));
    const file = join(users, "probe.json");
    await Deno.copyFile("fixtures/probe-mods/lstack-shape/profile.json", file);
    await Deno.chmod(file, 0o600);
    const profiles = await ProfileSet.load({ userDir: users, log: () => {} });
    assertEquals(profiles.profileFor("lstack-herdr").id, "lstack-shape");
    const source = await Deno.readTextFile("fixtures/probe-mods/lstack-shape/main.js");
    const listing = source.match(/const listing = '([^']+)'/)?.[1].replaceAll("\\\\", "\\");
    const picture = source.match(/const picture = '([^']+)'/)?.[1].replaceAll("\\\\", "\\");
    assert(listing && picture);
    const bin = join(home, ".local/bin/cockpit");
    const cockpit = { bin, home };
    const policies = new FolderPolicies(profiles, { home, appHome: app, spaceFolders: [], cockpit });
    const roots = await ReadRoots.resolve(app, [{ path: app, kind: "dir" }]);
    const ctx = policyContext({
      roots,
      paths: { home, appHome: app, state: home, run: home, repo: home },
      loadedFolders: new Set(["lstack-herdr"]),
      cockpit,
      env: { PATH: "/bin" },
      log: () => {},
      herdrVersion: "0.1.14",
    }, policies);
    const req = { folder: "lstack-herdr", method: "exec" as const, scope: "act" as const, session: "device" };
    const scan = join(components, "lh-scan.mjs");
    const sync = join(app, "mods/lstack-herdr/sync.mjs");
    const envArgs = [`HOME=${home}`, `HERDR_APP_HOME=${app}`, "COCKPIT_FRONTEND=app", bin, "hub", "start"];
    const pictureArgs = ["-c", picture, "sh", join(pictureDir, "picture"), "https://example.com/image.png"];
    assertEquals((await decideExec(ctx, { ...req, command: "node", argv: [scan, "tree"] })).kind, "script");
    assertEquals((await decideExec(ctx, { ...req, command: "node", argv: [sync, "--json"] })).kind, "refuse");
    assertEquals((await decideExec(ctx, { ...req, command: "env", argv: envArgs })).kind, "spawn");
    assertEquals(
      (await decideExec(ctx, { ...req, command: "sh", argv: ["-c", listing, "files", app] })).kind,
      "listing",
    );
    assertEquals((await decideExec(ctx, { ...req, command: "sh", argv: pictureArgs })).kind, "script");
    assertEquals((await decideExec(ctx, { ...req, command: "node", argv: [scan, "unknown"] })).kind, "refuse");
    assertEquals(
      (await decideExec(ctx, { ...req, command: "env", argv: ["DYLD_INSERT_LIBRARIES=x", ...envArgs] })).kind,
      "refuse",
    );
    assertEquals(
      (await decideExec(ctx, { ...req, command: "sh", argv: ["-c", listing + " ", "files", app] })).kind,
      "refuse",
    );
    assertEquals(
      (await decideExec(ctx, { ...req, command: "sh", argv: [...pictureArgs.slice(0, 4), "file:///etc/hosts"] })).kind,
      "refuse",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
