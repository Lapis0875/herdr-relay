import { assert, assertEquals } from "@std/assert";
import { decideExec, FolderPolicies, policyContext, ProfileSet, ReadRoots } from "../../../src/policy/mod.ts";

Deno.test("E14 pins the listing literal in the shipped 0.1.14 files fixture", async () => {
  const appHome = await Deno.realPath("fixtures/generic-home");
  const source = await Deno.readTextFile(`${appHome}/mods/files/main.js`);
  const match = source.match(/const script = '([^']+)'/);
  assert(match, "shipped files fixture must contain its listing literal");
  const literal = match[1].replaceAll("\\\\", "\\");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(literal));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const profiles = await ProfileSet.load({ log: () => {} });
  assertEquals(profiles.profileFor("files").shLiterals?.[hash], "listing");
  const policies = new FolderPolicies(profiles, { home: appHome, appHome, spaceFolders: [appHome], cockpit: null });
  const roots = await ReadRoots.resolve(appHome, [{ path: appHome, kind: "dir" }]);
  const ctx = policyContext({
    roots,
    paths: { home: appHome, appHome, state: appHome, run: appHome, repo: appHome },
    loadedFolders: new Set(["files"]),
    cockpit: null,
    env: { PATH: "/bin" },
    log: () => {},
    herdrVersion: "0.1.14",
  }, policies);
  const req = { folder: "files", method: "exec" as const, command: "sh", scope: "act" as const, session: "device" };
  assertEquals((await decideExec(ctx, { ...req, argv: ["-c", literal, "files", appHome] })).kind, "listing");
  assertEquals((await decideExec(ctx, { ...req, argv: ["-c", literal + " ", "files", appHome] })).kind, "refuse");
  assertEquals(
    (await decideExec({ ...ctx, herdrVersion: "9.9.9" }, { ...req, argv: ["-c", literal, "files", appHome] })).kind,
    "refuse",
  );
});
