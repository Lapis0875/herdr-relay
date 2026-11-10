import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

Deno.test({
  name: "S32 Deno production bridge flags block self-test probes",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    await Deno.mkdir(".tmp", { recursive: true });
    const temporary = await Deno.makeTempDir({ dir: ".tmp", prefix: "bridge-flags-" });
    try {
      // The ordinary Deno cache must remain available to --cached-only. The self-test
      // only loads configuration; its app-home write probe targets the temporary tree.
      const home = Deno.env.get("HOME");
      assert(home, "HOME is required for the installed Deno cache");
      const tmp = await Deno.realPath(temporary);
      const appHome = join(tmp, "app");
      await Deno.mkdir(appHome, { recursive: true });
      const config = JSON.parse(await Deno.readTextFile("deno.json")) as { tasks: { start: string } };
      const task = config.tasks.start;
      assert(!/['"`;|&<>\\]/.test(task), "start task uses shell syntax this test cannot safely expand");
      const words = task.trim().split(/\s+/);
      assertEquals(words.shift(), "deno");
      assertEquals(words.at(-1), "packages/bridge/src/main.ts");
      const args = words.map((word) => {
        const expanded = word.replace(/\$(HOME|TMPDIR)\b/g, (_match, name: string) => name === "HOME" ? home : tmp);
        assert(!expanded.includes("$"), `unhandled shell variable in start task: ${word}`);
        return expanded;
      });
      args.push("--self-test");
      const result = await new Deno.Command("deno", {
        args,
        clearEnv: true,
        env: { HOME: home, TMPDIR: tmp, HERDR_APP_HOME: appHome, PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);
      assert(stdout.trim() !== "", `bridge produced no self-test output (exit ${result.code}): ${stderr}`);
      const probes = stdout.trim().split("\n").map((line) => JSON.parse(line) as { probe: string; blocked: boolean });
      assertEquals(probes.map((p) => p.probe), [
        "read /etc/hosts",
        "read ~/.ssh",
        "write appHome",
        "spawn ls",
        "spawn /bin/sh",
        "spawn /usr/bin/curl",
        "connect 1.1.1.1:80",
        "listen 0.0.0.0",
        "import https://",
      ]);
      assertEquals(probes.filter((p) => !p.blocked), [], `${stdout}\n${stderr}`);
      assertEquals(result.code, 0, stderr);
    } finally {
      await Deno.remove(temporary, { recursive: true });
    }
  },
});
