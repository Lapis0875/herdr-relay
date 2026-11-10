import { assertEquals } from "@std/assert";
import { resolvePlatform } from "../../../src/platform.ts";
import { decideExec, FolderPolicies, policyContext, ProfileSet, ReadRoots } from "../../../src/policy/mod.ts";

Deno.test("profile E11/E12 flips by host platform and rejects non-web URLs", async () => {
  const appHome = await Deno.realPath("fixtures/generic-home");
  const profiles = await ProfileSet.load({ log: () => {} });
  const policies = new FolderPolicies(profiles, { home: appHome, appHome, spaceFolders: [], cockpit: null });
  const roots = await ReadRoots.resolve(appHome, [{ path: appHome, kind: "dir" }]);
  for (const [os, device, foreign] of [["darwin", "open", "xdg-open"], ["linux", "xdg-open", "open"]] as const) {
    const platform = resolvePlatform({ os, env: () => undefined, isFile: () => false, mayRun: () => false });
    const ctx = policyContext({
      roots,
      paths: { home: appHome, appHome, state: appHome, run: appHome, repo: appHome },
      loadedFolders: new Set(["win98"]),
      cockpit: null,
      env: { PATH: "/bin" },
      log: () => {},
      platform,
    }, policies);
    const request = { folder: "win98", method: "exec" as const, scope: "act" as const, session: "device" };
    const good = await decideExec(ctx, { ...request, command: device, argv: ["https://example.com/"] });
    assertEquals(good.kind, "open-url");
    assertEquals(good.rule, "E11");
    const wrong = await decideExec(ctx, { ...request, command: foreign, argv: ["https://example.com/"] });
    assertEquals(wrong.kind, "refuse");
    assertEquals(wrong.rule, "E12");
    assertEquals((await decideExec(ctx, { ...request, command: device, argv: ["file:///etc/hosts"] })).kind, "refuse");
  }
});
