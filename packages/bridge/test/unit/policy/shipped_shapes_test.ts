import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { decideExec, FolderPolicies, policyContext, ProfileSet, ReadRoots } from "../../../src/policy/mod.ts";

Deno.test("shipped git and hc shapes retain structural refusals and rooted git-dir", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "shipped-shapes-" });
  try {
    const root = await Deno.realPath(dir);
    const repo = join(root, "repo");
    const gitDir = join(repo, ".git");
    const app = join(root, "app");
    await Deno.mkdir(gitDir, { recursive: true });
    await Deno.mkdir(app);
    const roots = await ReadRoots.resolve(app, [{ path: repo, kind: "dir" }]);
    const profiles = await ProfileSet.load({ log: () => {} });
    const policies = new FolderPolicies(profiles, { home: root, appHome: app, spaceFolders: [repo], cockpit: null });
    const ctx = policyContext({
      roots,
      paths: { home: root, appHome: app, state: root, run: root, repo: root },
      loadedFolders: new Set(["worktree", "spaces"]),
      cockpit: null,
      env: { PATH: "/bin" },
      log: () => {},
    }, policies);
    const req = {
      folder: "worktree",
      method: "exec" as const,
      command: "git",
      scope: "act" as const,
      session: "device",
      options: { cwd: repo },
    };
    for (
      const argv of [
        ["worktree", "list", "--porcelain"],
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ["show-ref", "--verify", "--quiet", "refs/heads/main"],
        ["cat-file", "-e", "HEAD"],
        ["rev-list", "-n1", "--all", "--not", "--remotes"],
        ["--git-dir", gitDir, "rev-parse", "--git-dir"],
      ]
    ) {
      assertEquals((await decideExec(ctx, { ...req, argv })).kind, "spawn", argv.join(" "));
    }
    for (
      const argv of [["worktree", "add", "new"], ["worktree", "remove", "new"], [
        "--git-dir",
        root,
        "rev-parse",
        "--git-dir",
      ], ["cat-file", "-p", "HEAD"]]
    ) {
      assertEquals((await decideExec(ctx, { ...req, argv })).kind, "refuse", argv.join(" "));
    }
    const spaces = { ...req, folder: "spaces" };
    for (
      const argv of [
        ["rev-parse", "--path-format=absolute", "--show-toplevel"],
        ["symbolic-ref", "-q", "HEAD"],
        ["symbolic-ref", "--quiet", "HEAD"],
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      ]
    ) {
      assertEquals((await decideExec(ctx, { ...spaces, argv })).kind, "spawn", argv.join(" "));
    }
    for (
      const argv of [
        ["rev-parse", "--path-format=absolute", "--show-toplevel", "--output=outside"],
        ["symbolic-ref", "-q", "HEAD", "refs/heads/main"],
        ["symbolic-ref", "-d", "HEAD"],
        ["symbolic-ref", "--delete", "HEAD"],
        ["symbolic-ref", "-m", "message", "HEAD"],
        ["symbolic-ref", "--short", "HEAD"],
        ["symbolic-ref", "--", "HEAD"],
        ["rev-list", "--left-right", "--count"],
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}", "HEAD"],
        ["rev-list", "--left-right", "--count", "--all"],
      ]
    ) {
      assertEquals((await decideExec(ctx, { ...spaces, argv })).kind, "refuse", argv.join(" "));
    }
    const hc = { folder: "spaces", method: "hc" as const, command: "", scope: "act" as const, session: "device" };
    assertEquals((await decideExec(ctx, { ...hc, argv: ["machine", "ls", "--json"] })).kind, "spawn");
    for (const argv of [["machine", "add", "host", "--json"], ["machine", "rm", "host", "--json"]]) {
      assertEquals((await decideExec(ctx, { ...hc, argv })).kind, "refuse");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
