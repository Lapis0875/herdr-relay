import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { prepareLink } from "../../../packages/bridge/test/security/git_link.ts";
import { applyRemote, applySync, main, mergeKeys, parseTarget, planSync, UsageError } from "../mod.ts";
import { copiedPaths, readTree, targetFiles, withFixture, writeTree } from "./fixture.ts";

const sorted = (paths: string[]) => [...paths].sort();

// Capture the CLI report without starting a separate Deno process.
async function captureMain(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => stdout.push(values.join(" "));
  console.error = (...values: unknown[]) => stderr.push(values.join(" "));
  try {
    const code = await main(args);
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

Deno.test("dry-run prints exactly the specified yes set and changes neither home", async () => {
  await withFixture(async (source, target) => {
    const beforeSource = await readTree(source);
    const beforeTarget = await readTree(target);
    const result = await captureMain(["--source", source, "--target", target]);
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(result.stdout, "dry run");
    const lines = result.stdout.split("\n");
    const header = lines.findIndex((line) => /^copy \(\d+\):$/.test(line));
    assert(header >= 0, result.stdout);
    const copyLines: string[] = [];
    for (let i = header + 1; i < lines.length && lines[i].startsWith("  "); i++) {
      copyLines.push(lines[i].slice(2));
    }
    assertEquals(lines[header], `copy (${copiedPaths.length}):`);
    assertEquals(copyLines, sorted(copiedPaths));
    assertStringIncludes(result.stdout, "layout:lstack-herdr");
    for (
      const forbidden of [
        "shared.json",
        "view.json",
        "window.json",
        "seen.json",
        "cockpit.json",
        "layouts/.state",
        "data/",
      ]
    ) {
      assert(!result.stdout.includes(forbidden), `dry-run disclosed excluded path ${forbidden}`);
    }
    assertEquals(await readTree(source), beforeSource);
    assertEquals(await readTree(target), beforeTarget);
  });
});

Deno.test("local apply copies only the yes set and preserves all target-only files", async () => {
  await withFixture(async (source, target) => {
    const beforeSource = await readTree(source);
    const plan = await planSync(source);
    assertEquals(plan.files, sorted(copiedPaths));
    assertEquals(sorted(plan.keysSections), ["layout:lstack-herdr", "mod:lstack-herdr", "mod:lstack-herdr-cockpit"]);
    const result = await captureMain(["--source", source, "--target", target, "--apply"]);
    assertEquals(result.code, 0, result.stderr);
    const expected = { ...targetFiles };
    for (const path of copiedPaths) expected[path] = beforeSource[path];
    const keys = JSON.parse(targetFiles["keys.json"]);
    const sourceKeys = JSON.parse(beforeSource["keys.json"]);
    for (const section of plan.keysSections) keys[section] = sourceKeys[section];
    const actual = await readTree(target);
    assertEquals(JSON.parse(actual["keys.json"]), keys);
    delete actual["keys.json"];
    delete expected["keys.json"];
    assertEquals(actual, expected);
    assertEquals(await readTree(source), beforeSource);
  });
});

Deno.test("keys merge replaces selected sections and is deterministic and idempotent", async () => {
  await withFixture(async (source, target) => {
    const plan = await planSync(source);
    await applySync(plan, target);
    const first = await Deno.readTextFile(`${target}/keys.json`);
    await applySync(plan, target);
    const second = await Deno.readTextFile(`${target}/keys.json`);
    assertEquals(second, first);
    assertEquals(JSON.parse(first), {
      global: { "alt-a": "target-global" },
      "layout:lstack-herdr": { "alt-z": "source-z", "alt-a": "source-a" },
      "mod:lstack-herdr": { "alt-m": "source-mod" },
      "mod:lstack-herdr-cockpit": { "alt-c": "source-cockpit" },
      "layout:other": { "alt-o": "target-other" },
      terminal: { "ctrl-c": "target-terminal" },
    });
    const sourceKeys = JSON.parse((await readTree(source))["keys.json"]);
    const targetKeys = JSON.parse(targetFiles["keys.json"]);
    const beforeSource = structuredClone(sourceKeys);
    const beforeTarget = structuredClone(targetKeys);
    assertEquals(mergeKeys(targetKeys, sourceKeys, plan.keysSections), JSON.parse(first));
    assertEquals(sourceKeys, beforeSource);
    assertEquals(targetKeys, beforeTarget);
  });
});

Deno.test("remote dry run prints the exact planned rsync commands without executing them", async () => {
  await withFixture(async (source, target) => {
    const beforeSource = await readTree(source);
    const beforeTarget = await readTree(target);
    const remote = "person@example.invalid:/tmp/herdr-test";
    assertEquals(parseTarget(remote), { kind: "remote", spec: remote });
    const plan = await planSync(source);
    const result = await captureMain(["--source", source, "--target", remote, "--rsh", "ssh -p 2222"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stdout.split("\n").filter((line) => line.startsWith("  rsync ")).map((line) => line.slice(2)), [
      `rsync -rt -e 'ssh -p 2222' --include=/keys.json '--exclude=*' ${remote}/ '<temp>/'`,
      `rsync -rtm --omit-dir-times -e 'ssh -p 2222' --exclude=gpui-kit.d.ts --exclude=jsconfig.json ` +
      `--include=/layouts/ --include=/layouts/lstack-herdr.json --include=/layouts/lstack-herdr.svg ` +
      `--include=/mods/ '--include=/mods/lstack-herdr-cockpit/***' '--include=/mods/lstack-herdr/***' ` +
      `'--exclude=*' ${plan.source}/ ${remote}/`,
      `rsync -t --ignore-times -e 'ssh -p 2222' '<temp>/keys.json' ${remote}/keys.json`,
    ]);
    assertEquals(await readTree(source), beforeSource);
    assertEquals(await readTree(target), beforeTarget);
  });
});

Deno.test("remote dry run selects explicit rsh over RSYNC_RSH, then defaults to ssh", async () => {
  await withFixture(async (source) => {
    const previous = Deno.env.get("RSYNC_RSH");
    try {
      Deno.env.set("RSYNC_RSH", "ssh -p 2022");
      const args = ["--source", source, "--target", "person@example.invalid:app"];
      const fromEnv = await captureMain(args);
      assertEquals(fromEnv.code, 0, fromEnv.stderr);
      assertStringIncludes(fromEnv.stdout, "-e 'ssh -p 2022'");
      const explicit = await captureMain([...args, "--rsh", "ssh -p 3030"]);
      assertEquals(explicit.code, 0, explicit.stderr);
      assertStringIncludes(explicit.stdout, "-e 'ssh -p 3030'");
      assert(!explicit.stdout.includes("ssh -p 2022"));
      Deno.env.delete("RSYNC_RSH");
      const fallback = await captureMain(args);
      assertEquals(fallback.code, 0, fallback.stderr);
      assertStringIncludes(fallback.stdout, "-e ssh ");
    } finally {
      if (previous === undefined) Deno.env.delete("RSYNC_RSH");
      else Deno.env.set("RSYNC_RSH", previous);
    }
  });
});

Deno.test("--rsh is rejected for local targets in dry run and apply", async () => {
  await withFixture(async (source, target) => {
    const before = await readTree(target);
    for (const apply of [false, true]) {
      const result = await captureMain([
        "--source",
        source,
        "--target",
        target,
        "--rsh",
        "ssh -p 2222",
        ...(apply ? ["--apply"] : []),
      ]);
      assertEquals(result.code, 2);
      assertStringIncludes(result.stderr, "--rsh");
    }
    assertEquals(await readTree(target), before);
  });
});

Deno.test("remote apply orders exact rsync arguments and sends only changed merged keys", async () => {
  await withFixture(async (source, target) => {
    const plan = await planSync(source);
    const remote = "person@example.invalid:app";
    const calls: string[][] = [];
    let merged = "";
    const result = await applyRemote(plan, remote, {
      rsh: "ssh -p 2222",
      tempDir: target,
      run: async (args) => {
        calls.push([...args]);
        if (calls.length === 1) {
          await Deno.writeTextFile(`${args[args.length - 1]}keys.json`, targetFiles["keys.json"]);
        } else if (calls.length === 3) {
          merged = await Deno.readTextFile(args[args.length - 2]);
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const temp = calls[0][calls[0].length - 1].slice(0, -1);
    assertEquals(calls, [
      ["-rt", "-e", "ssh -p 2222", "--include=/keys.json", "--exclude=*", `${remote}/`, `${temp}/`],
      [
        "-rtm",
        "--omit-dir-times",
        "-e",
        "ssh -p 2222",
        "--exclude=gpui-kit.d.ts",
        "--exclude=jsconfig.json",
        "--include=/layouts/",
        "--include=/layouts/lstack-herdr.json",
        "--include=/layouts/lstack-herdr.svg",
        "--include=/mods/",
        "--include=/mods/lstack-herdr-cockpit/***",
        "--include=/mods/lstack-herdr/***",
        "--exclude=*",
        `${plan.source}/`,
        `${remote}/`,
      ],
      ["-t", "--ignore-times", "-e", "ssh -p 2222", `${temp}/keys.json`, `${remote}/keys.json`],
    ]);
    assertEquals(result.keys, "merged");
    assertEquals(result.copied, sorted(copiedPaths));
    assertEquals(
      merged,
      JSON.stringify(
        mergeKeys(
          JSON.parse(targetFiles["keys.json"]),
          JSON.parse((await readTree(source))["keys.json"]),
          plan.keysSections,
        ),
        null,
        2,
      ) + "\n",
    );
    await assertRejects(() => Deno.stat(temp), Deno.errors.NotFound);
  });
});

Deno.test("remote apply skips keys push when missing or unchanged and skips pull without sections", async () => {
  await withFixture(async (source, target) => {
    const plan = await planSync(source);
    const sourceKeys = JSON.parse((await readTree(source))["keys.json"]);
    const matching = JSON.stringify(mergeKeys(JSON.parse(targetFiles["keys.json"]), sourceKeys, plan.keysSections));
    for (const [text, outcome] of [[null, "no-target-keys"], [matching, "unchanged"]] as const) {
      const calls: string[][] = [];
      const result = await applyRemote(plan, "person@example.invalid:app", {
        rsh: "ssh",
        tempDir: target,
        run: async (args) => {
          calls.push([...args]);
          if (calls.length === 1 && text !== null) {
            await Deno.writeTextFile(`${args[args.length - 1]}keys.json`, text);
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      assertEquals(result.keys, outcome);
      assertEquals(calls.length, 2);
      assertEquals(calls[0][0], "-rt");
      assertEquals(calls[1][0], "-rtm");
    }
    const calls: string[][] = [];
    const result = await applyRemote({ ...plan, keysSections: [] }, "person@example.invalid:app", {
      rsh: "ssh",
      tempDir: target,
      run: (args) => {
        calls.push([...args]);
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    });
    assertEquals(result.keys, "no-sections");
    assertEquals(calls.length, 1);
    assertEquals(calls[0][0], "-rtm");
  });
});

Deno.test("remote invalid keys and rsync failures stop before subsequent sends", async () => {
  await withFixture(async (source, target) => {
    const plan = await planSync(source);
    for (const invalid of ["{invalid", "[]", "null"]) {
      let calls = 0;
      await assertRejects(() =>
        applyRemote(plan, "person@example.invalid:app", {
          rsh: "ssh",
          tempDir: target,
          run: async (args) => {
            calls++;
            await Deno.writeTextFile(`${args[args.length - 1]}keys.json`, invalid);
            return { code: 0, stdout: "", stderr: "" };
          },
        })
      );
      assertEquals(calls, 1);
    }
    for (const failAt of [1, 2, 3]) {
      const calls: string[][] = [];
      const error = await assertRejects(() =>
        applyRemote(plan, "person@example.invalid:app", {
          rsh: "ssh",
          tempDir: target,
          run: async (args) => {
            calls.push([...args]);
            if (calls.length === 1 && failAt !== 1) {
              await Deno.writeTextFile(`${args[args.length - 1]}keys.json`, targetFiles["keys.json"]);
            }
            return { code: calls.length === failAt ? 23 : 0, stdout: "", stderr: "rsync failure" };
          },
        })
      );
      assertEquals(calls.length, failAt);
      assert(error instanceof Error);
      assertStringIncludes(error.message, "rsync exited 23");
      assertStringIncludes(
        error.message,
        [
          "nothing was sent",
          "some may have been sent",
          "the files were sent",
        ][failAt - 1],
      );
      const temp = calls[0][calls[0].length - 1].slice(0, -1);
      await assertRejects(() => Deno.stat(temp), Deno.errors.NotFound);
    }
  });
});

Deno.test("remote rsync integration delivers planned files and deterministic keys without deleting PC files", async () => {
  await withFixture(async (source, target) => {
    const scriptDir = ".tmp/sync-config-remote-shell";
    await Deno.mkdir(scriptDir, { recursive: true });
    const script = `${await Deno.realPath(scriptDir)}/fake-rsh`;
    const log = `${await Deno.realPath(scriptDir)}/calls`;
    const previousTmp = Deno.env.get("TMPDIR");
    const previousRsh = Deno.env.get("RSYNC_RSH");
    try {
      await Deno.writeTextFile(
        script,
        `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != rsync ]; do shift; done
[ "$1" = rsync ] && [ "$2" = --server ] || exit 91
printf '%s\\n' "$*" >> '${log}'
exec "$@"
`,
      );
      await Deno.chmod(script, 0o700);
      const beforeSource = await readTree(source);
      const beforeTarget = await readTree(target);
      const plan = await planSync(source);
      const remote = `person@example.invalid:${await Deno.realPath(target)}`;
      Deno.env.set("TMPDIR", await Deno.realPath(target));
      Deno.env.set("RSYNC_RSH", script);
      const args = ["--source", source, "--target", remote, "--apply"];
      const first = await captureMain(args);
      assertEquals(first.code, 0, first.stderr);
      assertStringIncludes(first.stdout, "keys.json: merged");
      const expected = { ...beforeTarget };
      for (const path of copiedPaths) expected[path] = beforeSource[path];
      expected["keys.json"] = JSON.stringify(
        mergeKeys(
          JSON.parse(beforeTarget["keys.json"]),
          JSON.parse(beforeSource["keys.json"]),
          plan.keysSections,
        ),
        null,
        2,
      ) + "\n";
      assertEquals(await readTree(target), expected);
      const second = await captureMain(args);
      assertEquals(second.code, 0, second.stderr);
      assertStringIncludes(second.stdout, "already match");
      assertEquals(await readTree(target), expected);
      assertEquals(await readTree(source), beforeSource);
      const calls = (await Deno.readTextFile(log)).trim().split("\n");
      assertEquals(calls.length, 5);
      assert(calls.every((line) => line.startsWith("rsync --server ")));
      await Deno.writeTextFile(`${target}/keys.json`, "[]");
      const invalidTarget = await readTree(target);
      const invalid = await captureMain(args);
      assertEquals(invalid.code, 1);
      assertStringIncludes(invalid.stderr, "keys.json");
      assertEquals(await readTree(target), invalidTarget);
      assertEquals((await Deno.readTextFile(log)).trim().split("\n").length, 6);
      await Deno.remove(`${target}/keys.json`);
      const missing = await captureMain(args);
      assertEquals(missing.code, 0, missing.stderr);
      assertStringIncludes(missing.stdout, "target has no keys.json");
      assert(!Object.hasOwn(await readTree(target), "keys.json"));
      assertEquals((await Deno.readTextFile(log)).trim().split("\n").length, 8);
      assertEquals(await readTree(source), beforeSource);
    } finally {
      if (previousTmp === undefined) Deno.env.delete("TMPDIR");
      else Deno.env.set("TMPDIR", previousTmp);
      if (previousRsh === undefined) Deno.env.delete("RSYNC_RSH");
      else Deno.env.set("RSYNC_RSH", previousRsh);
      await Deno.remove(scriptDir, { recursive: true });
    }
  });
});

Deno.test("generic home contains no user layout, mod, keys section or review item", async () => {
  const plan = await planSync("fixtures/generic-home");
  assertEquals(plan.files, []);
  assertEquals(plan.layouts, []);
  assertEquals(plan.mods, []);
  assertEquals(plan.keysSections, []);
  assertEquals(plan.optIn, []);
});

Deno.test("review items require explicit inclusion and unreferenced mods stay excluded", async () => {
  await withFixture(async (source, target) => {
    const before = await readTree(source);
    const plan = await planSync(source);
    assert(!plan.files.some((path) => path.startsWith("mods/lstack-herdr-other/")));
    const review = ["my-icons/nested/star.svg", "programs.json", "themes/dark.json"];
    for (const path of review) assert(plan.optIn.includes(path), `missing review item ${path}`);
    const args = ["--source", source, "--target", target, "--apply"];
    for (const path of review) args.push("--include", path);
    const result = await captureMain(args);
    assertEquals(result.code, 0, result.stderr);
    const after = await readTree(target);
    for (const path of review) assertEquals(after[path], before[path]);
    assertEquals(await readTree(source), before);
  });
});

Deno.test("include refuses excluded state files", async () => {
  await withFixture(async (source, target) => {
    const before = await readTree(target);
    const result = await captureMain([
      "--source",
      source,
      "--target",
      target,
      "--include",
      "shared.json",
      "--apply",
    ]);
    assertEquals(result.code, 2);
    assertEquals(await readTree(target), before);
  });
});

Deno.test("target without keys is not given a partial keys file", async () => {
  await withFixture(async (source, target) => {
    await Deno.remove(`${target}/keys.json`);
    const result = await captureMain(["--source", source, "--target", target, "--apply"]);
    assertEquals(result.code, 0, result.stderr);
    const files = await readTree(target);
    assert(!Object.hasOwn(files, "keys.json"));
  });
});

Deno.test("apply refuses a symlink inside target instead of writing outside it", async () => {
  await withFixture(async (source, target) => {
    const beforeSource = await readTree(source);
    await Deno.remove(`${target}/layouts`, { recursive: true });
    const absoluteTarget = await Deno.realPath(target);
    const createLink = await prepareLink(absoluteTarget, `${absoluteTarget}/layouts`, await Deno.realPath(source));
    await createLink();
    const result = await captureMain(["--source", source, "--target", target, "--apply"]);
    assert(result.code !== 0, "a symlink target must be refused");
    assertEquals(await readTree(source), beforeSource);
  });
});

Deno.test("invalid keys and overlapping homes are rejected without changing source", async () => {
  await withFixture(async (source, target) => {
    await writeTree(target, { "keys.json": "[invalid json" });
    const beforeSource = await readTree(source);
    const beforeTarget = await readTree(target);
    const invalid = await captureMain(["--source", source, "--target", target, "--apply"]);
    assert(invalid.code !== 0, "invalid target keys must be rejected");
    assertEquals(await readTree(source), beforeSource);
    assertEquals(await readTree(target), beforeTarget);
    const overlap = await captureMain(["--source", source, "--target", `${source}/inside`, "--apply"]);
    assert(overlap.code !== 0, "source and target must not overlap");
    assertEquals(await readTree(source), beforeSource);
  });
});

Deno.test("missing source is rejected", async () => {
  await withFixture(async (source) => {
    await assertRejects(() => planSync(`${source}/does-not-exist`));
  });
});

const usage = "usage: sync-config [--source <appHome>] --target <dir | [user@]host:path> [--include <path>]... " +
  "[--rsh <remote shell>] [--apply]";
const remoteHint = "use a path without spaces or shell characters (letters, digits and . _ / ~ @ + -)";

Deno.test("unsafe remote target components are refused before any writes", async () => {
  await withFixture(async (source, target) => {
    const beforeSource = await readTree(source);
    const beforeTarget = await readTree(target);
    const cases = [
      ["me@pc:my dir", "my dir"],
      ["me@pc:a;b", "a;b"],
      ["me@pc:$HOME/x", "$HOME/x"],
      ["me@pc:a:b", "a:b"],
      ["me@pc:`id`", "`id`"],
      ["me@pc:it's", "it's"],
      ["bad host:x", "bad host"],
      ["me@p c:x", "me@p c"],
      ["a@b@c:x", "a@b@c"],
    ];
    for (const [spec, part] of cases) {
      for (const apply of [false, true]) {
        const result = await captureMain(["--source", source, "--target", spec, ...(apply ? ["--apply"] : [])]);
        assertEquals(result, {
          code: 2,
          stdout: "",
          stderr: `sync-config: --target ${spec}: ${
            JSON.stringify(part)
          } has a space or shell character; ${remoteHint}\n${usage}`,
        }, `${spec} apply=${apply}`);
      }
    }
    for (const spec of ["host:", ":x"]) {
      const result = await captureMain(["--source", source, "--target", spec, "--apply"]);
      assertEquals(result, {
        code: 2,
        stdout: "",
        stderr:
          `sync-config: --target ${spec}: a remote target is [user@]host:path, with the app home's path\n${usage}`,
      }, spec);
    }
    assertEquals(await readTree(source), beforeSource);
    assertEquals(await readTree(target), beforeTarget);
  });
});

Deno.test("safe remote target paths are accepted in dry runs", async () => {
  await withFixture(async (source, target) => {
    const beforeSource = await readTree(source);
    const beforeTarget = await readTree(target);
    for (const spec of ["me@pc:~/.config/herdr-app", "me@pc:.config/herdr-app", "pc:/abs/herdr-app+x_y-1@2"]) {
      const result = await captureMain(["--source", source, "--target", spec]);
      assertEquals(result.code, 0, `${spec}: ${result.stderr}`);
      assertEquals(result.stderr, "", spec);
      assertStringIncludes(result.stdout, spec);
    }
    assertEquals(await readTree(source), beforeSource);
    assertEquals(await readTree(target), beforeTarget);
  });
});

Deno.test("unsafe planned filenames are refused remotely but accepted locally", async () => {
  await withFixture(async (source, target) => {
    const rel = "mods/lstack-herdr/a b.js";
    await Deno.writeTextFile(`${source}/${rel}`, "space in filename\n");
    const beforeSource = await readTree(source);
    const beforeTarget = await readTree(target);
    const plan = await planSync(source);
    assert(plan.files.includes(rel));
    const message =
      `${rel}: a file with a space or shell character can't go to a remote target; ${remoteHint}, or sync to a local folder`;
    const result = await captureMain(["--source", source, "--target", "me@pc:app"]);
    assertEquals(result, { code: 2, stdout: "", stderr: `sync-config: ${message}\n${usage}` });
    const local = await captureMain(["--source", source, "--target", target]);
    assertEquals(local.code, 0, local.stderr);
    assertStringIncludes(local.stdout, rel);
    let calls = 0;
    await assertRejects(
      () =>
        applyRemote(plan, "me@pc:app", {
          rsh: "ssh",
          tempDir: target,
          run: () => {
            calls++;
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          },
        }),
      UsageError,
      message,
    );
    assertEquals(calls, 0);
    assertEquals(await readTree(source), beforeSource);
    assertEquals(await readTree(target), beforeTarget);
  });
});

Deno.test("remote apply rejects unsafe planned filenames before creating temporary files", async () => {
  await withFixture(async (source, target) => {
    const rel = "mods/lstack-herdr/a b.js";
    await Deno.writeTextFile(`${source}/${rel}`, "space in filename\n");
    const beforeSource = await readTree(source);
    const beforeTarget = await readTree(target);
    const result = await captureMain(["--source", source, "--target", "me@pc:app", "--apply"]);
    const message =
      `${rel}: a file with a space or shell character can't go to a remote target; ${remoteHint}, or sync to a local folder`;
    assertEquals(result, { code: 2, stdout: "", stderr: `sync-config: ${message}\n${usage}` });
    assertEquals(await readTree(source), beforeSource);
    assertEquals(await readTree(target), beforeTarget);
  });
});
