import { assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { decideExec, FolderPolicies, policyContext, ProfileSet, ReadRoots, runPlan } from "../../../src/policy/mod.ts";

Deno.test("E4 refuses branch mutations, abbreviated dangerous options and unsafe diffs", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "git-policy-" });
  try {
    const home = await Deno.realPath(dir);
    const app = join(home, "app");
    const repo = join(home, "repo");
    const outside = join(home, "outside");
    await Deno.mkdir(app);
    await Deno.mkdir(repo);
    await Deno.mkdir(outside);
    await Deno.writeTextFile(join(repo, "README"), "baseline\n");
    await Deno.writeTextFile(join(outside, "secret"), "outside\n");
    const path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
    const git = async (args: string[]): Promise<string> => {
      const result = await new Deno.Command("git", {
        args,
        cwd: repo,
        clearEnv: true,
        env: { HOME: home, PATH: path, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      return new TextDecoder().decode(result.stdout).trim();
    };
    await git(["init", "-q", "-b", "main"]);
    await git(["add", "README"]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
    const profiles = await ProfileSet.load({ log: () => {} });
    const roots = await ReadRoots.resolve(app, [{ path: repo, kind: "dir" }]);
    const policies = new FolderPolicies(profiles, { home, appHome: app, spaceFolders: [repo], cockpit: null });
    const ctx = policyContext({
      roots,
      paths: { home, appHome: app, state: home, run: home, repo: home },
      loadedFolders: new Set(["files", "worktree"]),
      cockpit: null,
      env: { PATH: path },
      log: () => {},
    }, policies);
    const base = {
      folder: "worktree",
      method: "exec" as const,
      command: "git",
      scope: "act" as const,
      session: "device",
      options: { cwd: repo },
    };
    const branches = () => git(["branch", "--format=%(refname:short)"]);
    assertEquals(await branches(), "main");
    for (
      const argv of [["branch", "--", "evil"], ["branch", "--color", "evil"], ["branch", "--abbrev", "evil"], [
        "branch",
        "--color",
        "--set-upstream-to=main",
      ]]
    ) {
      const plan = await decideExec(ctx, { ...base, argv });
      assertEquals(plan.kind, "refuse", argv.join(" "));
      assertEquals((await runPlan(plan)).code, 126);
      assertEquals(await branches(), "main", `refs changed after ${argv.join(" ")}`);
    }
    for (
      const argv of [["branch", "--list", "x*"], ["branch", "--contains", "HEAD"], ["branch", "--merged"], [
        "status",
        "--porc",
      ], ["rev-parse", "--git-dir"]]
    ) {
      assertEquals((await decideExec(ctx, { ...base, argv })).kind, "spawn", argv.join(" "));
    }
    const gitDir = join(repo, ".git");
    for (
      const argv of [
        ["--git-d", gitDir, "status"],
        ["status", "--out=x"],
        ["diff", "--no-ind"],
        ["status", "--upload-p=x"],
        ["status", "--config-e=x"],
        ["rev-parse", "--git-d"],
      ]
    ) {
      assertEquals((await decideExec(ctx, { ...base, argv })).kind, "refuse", argv.join(" "));
      assertEquals(
        (await decideExec(ctx, { ...base, argv: ["--git-dir", gitDir, ...argv] })).kind,
        "refuse",
        `git-dir ${argv.join(" ")}`,
      );
    }
    assertEquals(
      (await decideExec(ctx, { ...base, argv: ["diff", "README", join(outside, "secret")] })).kind,
      "refuse",
    );
    const nonrepo = await new Deno.Command("deno", {
      args: [
        "run",
        "--no-prompt",
        "--allow-read=.",
        `--deny-read=${resolve(".git")}`,
        "packages/bridge/test/unit/policy/git_nonrepo_probe.ts",
        home,
        app,
        outside,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(nonrepo.code, 0, new TextDecoder().decode(nonrepo.stderr));
    assertEquals(new TextDecoder().decode(nonrepo.stdout).trim(), "refuse", "diff outside a visible worktree");
    assertEquals(await branches(), "main");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
