import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { HubProxy } from "../../../src/herdr/net.ts";
import {
  decideExec,
  FolderPolicies,
  policyContext,
  policyReadTextFile,
  PolicyRefusal,
  ProfileSet,
  ReadRoots,
} from "../../../src/policy/mod.ts";

Deno.test("profiles: unknown folder defaults to own data and spaces, never exec or hc", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "profiles-" });
  try {
    const root = await Deno.realPath(dir);
    const app = join(root, "app");
    const own = join(app, "mods", "unknown");
    const other = join(app, "mods", "other");
    const ownData = join(app, "data", "unknown");
    const space = join(root, "space");
    for (const path of [own, ownData, other, space]) await Deno.mkdir(path, { recursive: true });
    await Deno.writeTextFile(join(own, "own.txt"), "own");
    await Deno.writeTextFile(join(ownData, "own.txt"), "data");
    await Deno.writeTextFile(join(other, "secret.txt"), "other");
    await Deno.writeTextFile(join(space, "space.txt"), "space");
    const profiles = await ProfileSet.load({ log: () => {} });
    const policies = new FolderPolicies(profiles, { home: root, appHome: app, spaceFolders: [space], cockpit: null });
    const roots = await ReadRoots.resolve(app, [{ path: app, kind: "dir" }]);
    const ctx = policyContext({
      roots,
      paths: { home: root, appHome: app, state: root, run: root, repo: root },
      loadedFolders: new Set(["unknown"]),
      cockpit: null,
      env: { PATH: "/bin" },
      log: () => {},
    }, policies);
    assert(ctx.profileFor, "production policyContext must always install profileFor");
    const folder = await ctx.profileFor("unknown");
    assertEquals(folder.profile.id, "default");
    assertEquals(folder.profile.net, undefined);
    assertEquals(await policyReadTextFile(folder.roots, join(own, "own.txt")), "own");
    assertEquals(await policyReadTextFile(folder.roots, join(ownData, "own.txt")), "data");
    assertEquals(await policyReadTextFile(folder.roots, join(space, "space.txt")), "space");
    await assertRejects(() => policyReadTextFile(folder.roots, join(other, "secret.txt")), PolicyRefusal);
    const hub = new HubProxy({
      cockpit: () => null,
      profileFor: (name) => profiles.profileFor(name),
      policyLog: () => {},
      log: () => {},
    });
    await assertRejects(() => hub.connect("unknown", 1, "127.0.0.1", 22), PolicyRefusal);
    for (
      const [method, command, argv] of [["exec", "git", ["--version"]], ["hc", "", [
        "machine",
        "ls",
        "--json",
      ]]] as const
    ) {
      const decision = await decideExec(ctx, {
        folder: "unknown",
        method,
        command,
        argv: [...argv],
        scope: "act",
        session: "device",
      });
      assertEquals(decision.kind, "refuse");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("profiles: user priority wins and invalid user files are logged and ignored", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "profiles-priority-" });
  try {
    const userDir = join(dir, "profiles");
    await Deno.mkdir(userDir);
    const valid = join(userDir, "valid.json");
    const invalid = join(userDir, "invalid.json");
    await Deno.writeTextFile(valid, JSON.stringify({ id: "user-files", folders: ["files"] }));
    await Deno.writeTextFile(invalid, JSON.stringify({ id: "bad", folders: "files" }));
    await Deno.chmod(valid, 0o600);
    await Deno.chmod(invalid, 0o600);
    const logs: string[] = [];
    const profiles = await ProfileSet.load({ userDir, log: (line) => logs.push(line) });
    assertEquals(profiles.profileFor("files").id, "user-files");
    assertEquals(profiles.profileFor("changes").id, "herdr-shipped");
    assert(!profiles.entries.some((entry) => entry.profile.id === "bad"));
    assert(logs.some((line) => line.includes("invalid.json") && line.includes("ignored")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
