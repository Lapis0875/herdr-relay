import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

Deno.test("S10 bridge Deno environment flags deny DYLD_INSERT_LIBRARIES", async () => {
  await Deno.mkdir(".tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "security-env-" });
  try {
    const script = join(dir, "probe.ts");
    await Deno.writeTextFile(
      script,
      `
      const state = (await Deno.permissions.query({ name: "env", variable: "DYLD_INSERT_LIBRARIES" })).state;
      let error = "";
      try { Deno.env.get("DYLD_INSERT_LIBRARIES"); } catch (e) { error = e.name; }
      console.log(JSON.stringify({ state, error }));
    `,
    );
    const output = await new Deno.Command("deno", {
      args: [
        "run",
        "--no-prompt",
        "--no-config",
        "--no-remote",
        "--no-npm",
        "--allow-env=HOME,TMPDIR,HERDR_APP_HOME,HERDR_RELAY_PORT,HERDR_RELAY_DEV,PATH",
        script,
      ],
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const result = JSON.parse(new TextDecoder().decode(output.stdout)) as { state: string; error: string };
    assert(result.state !== "granted", `DYLD_INSERT_LIBRARIES unexpectedly granted: ${result.state}`);
    assertEquals(result.error, "NotCapable");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
