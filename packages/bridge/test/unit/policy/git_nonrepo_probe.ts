import { decideExec, FolderPolicies, policyContext, ProfileSet, ReadRoots } from "../../../src/policy/mod.ts";
import { resolvePlatform } from "../../../src/platform.ts";

// Parent denies read of the enclosing checkout's .git, matching the bridge's
// read-permission boundary and leaving the synthetic directory outside a visible worktree.
const [home, appHome, outside] = Deno.args;
const profiles = await ProfileSet.load({ log: () => {} });
const roots = await ReadRoots.resolve(appHome, [{ path: outside, kind: "dir" }]);
const policies = new FolderPolicies(profiles, { home, appHome, spaceFolders: [outside], cockpit: null });
const platform = resolvePlatform({ os: "darwin", env: () => undefined, isFile: () => false, mayRun: () => false });
const ctx = policyContext({
  roots,
  paths: { home, appHome, state: home, run: home, repo: home },
  loadedFolders: new Set(["worktree"]),
  cockpit: null,
  env: { PATH: "/bin" },
  log: () => {},
  platform,
}, policies);
const plan = await decideExec(ctx, {
  folder: "worktree",
  method: "exec",
  command: "git",
  argv: ["diff", "README", "secret"],
  options: { cwd: outside },
  scope: "act",
  session: "device",
});
console.log(plan.kind);
