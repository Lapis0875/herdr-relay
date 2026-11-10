import { assertEquals } from "@std/assert";
import { basename, dirname, join } from "@std/path";

/** Git creates the link without granting the test process unscoped Deno.symlink permissions. */
export async function prepareLink(root: string, link: string, target: string): Promise<() => Promise<void>> {
  const repository = join(root, "link-repo");
  const content = join(root, "link-target");
  await Deno.mkdir(repository);
  await Deno.writeTextFile(content, target);
  async function git(args: string[]): Promise<string> {
    const result = await new Deno.Command("git", {
      args: ["-C", repository, ...args],
      env: { HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  }
  await git(["init", "-q"]);
  await git(["config", "core.symlinks", "true"]);
  const object = await git(["hash-object", "-w", content]);
  const name = basename(link);
  await git(["update-index", "--add", "--cacheinfo", `120000,${object},${name}`]);
  return async () => {
    await git(["checkout-index", `--prefix=${dirname(link)}/`, name]);
    assertEquals((await Deno.lstat(link)).isSymlink, true);
  };
}
