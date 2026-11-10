// tools/scrub/check.ts against throwaway git work trees under .tmp/: a planted token fails the check (exit 1), the
// allowlisted spellings and ignored files pass (exit 0). Every planted value is assembled at run time (identifiers
// from IDENTITIES), so this file's own text passes the check of the repository.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { IDENTITIES } from "../check.ts";

const CHECK = new URL("../check.ts", import.meta.url).pathname;
const [NAME, HOST] = IDENTITIES;
const CAPITALIZED = NAME[0].toUpperCase() + NAME.slice(1);
const TAILNET = ["tail1a2b3c", "ts", "net"].join(".");
const decoder = new TextDecoder();

async function run(cmd: string, args: string[], cwd?: string) {
  const out = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" }).output();
  return { code: out.code, stdout: decoder.decode(out.stdout), stderr: decoder.decode(out.stderr) };
}

/** A fresh repository holding `files` (added to the index unless listed in `untracked`), checked by check.ts. */
async function check(files: Record<string, string>, untracked: string[] = []) {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "scrub-" });
  try {
    assertEquals((await run("git", ["init", "-q", dir])).code, 0);
    for (const [path, text] of Object.entries(files)) {
      const full = `${dir}/${path}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(full, text);
      if (!untracked.includes(path)) assertEquals((await run("git", ["-C", dir, "add", "--", path])).code, 0);
    }
    return await run("deno", ["run", "--allow-run=git", `--allow-read=${dir}`, CHECK, "--root", dir]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const CLEAN = {
  "README.md": [
    "git clone https://github.com/Lapis0875/herdr-relay.git",
    "brew tap Lapis0875/homebrew-herdr-relay",
    "launchctl print gui/501/io.github.lapis0875.herdr-relay",
    "Copyright 2026 Lapis0875",
    "Open https://<mac>.<tailnet>.ts.net/herdr-relay/ from <HOME>/.config/herdr-app",
  ].join("\n"),
  "samples/state.json":
    `{ "home": "/Users/sam", "cwd": "/Users/sam/work/example", "token": "Zr1v4bQnS8m2kXc7uE0aJw" }\n`,
  "tools/launchd/io.github.lapis0875.herdr-relay.plist": "<string>io.github.lapis0875.herdr-relay</string>\n",
};

Deno.test("a clean tree with only allowlisted spellings passes silently", async () => {
  const r = await check(CLEAN);
  assertEquals(r.code, 0, r.stdout + r.stderr);
  assertEquals(r.stdout, "");
});

Deno.test("a planted home path of the author fails with exit 1", async () => {
  const r = await check({ ...CLEAN, "docs/notes.md": `intro\nsee /Users/${NAME}/Agent-Tools/herdr-relay\n` });
  assertEquals(r.code, 1);
  assertStringIncludes(r.stdout, "docs/notes.md:2:5 home-path");
  assertStringIncludes(r.stdout, "docs/notes.md:2:12 author-name");
});

Deno.test("an untracked file that git add -A would publish is checked too", async () => {
  const r = await check({ ...CLEAN, "notes.txt": `open https://${HOST}-mac.${TAILNET}/\n` }, ["notes.txt"]);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stdout, "notes.txt:1:14 author-host");
  assertStringIncludes(r.stdout, "tailnet-host");
});

Deno.test("ignored files are not published, so not checked", async () => {
  const r = await check(
    { ...CLEAN, ".gitignore": "fixtures/private/\n", "fixtures/private/home.txt": `/Users/${NAME}\n` },
    ["fixtures/private/home.txt"],
  );
  assertEquals(r.code, 0, r.stdout + r.stderr);
});

Deno.test("the allowlist is exact: other spellings of the author's name fail", async () => {
  const r = await check({
    ...CLEAN,
    "a.md": `https://github.com/${NAME}/herdr-relay\nhttps://github.com/${CAPITALIZED}/other-repo\n`,
  });
  assertEquals(r.code, 1);
  assertStringIncludes(r.stdout, "a.md:1:20 author-name");
  assertStringIncludes(r.stdout, "a.md:2:20 author-name");
});

Deno.test("forbidden paths and hub tokens fail; secrets are redacted", async () => {
  const token = "c0ffee".repeat(6);
  const r = await check({
    ...CLEAN,
    "cache/hub.json": JSON.stringify({ port: 41999, token }, null, 2) + "\n",
    "fixtures/private/x.txt": "tracked by mistake\n",
  });
  assertEquals(r.code, 1);
  assertStringIncludes(r.stdout, "cache/hub.json:0:6 hub-json");
  assertStringIncludes(r.stdout, "cache/hub.json:2:3 hub-token <redacted,");
  assertStringIncludes(r.stdout, "fixtures/private/x.txt:0:1 private-fixture");
  assert(!r.stdout.includes(token), "the token itself is never printed");
});

Deno.test("usage errors exit 2", async () => {
  const r = await run("deno", ["run", "--allow-run=git", "--allow-read=.", CHECK, "--bogus"]);
  assertEquals(r.code, 2);
});
