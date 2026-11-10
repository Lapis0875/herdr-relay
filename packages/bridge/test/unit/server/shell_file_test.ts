import { assertEquals } from "@std/assert";
import { serveShell, shellFile } from "../../../src/server/shell.ts";

Deno.test("shellFile classifies decoded paths once and rejects unsafe paths", () => {
  for (const path of ["/", "/pane/t1", "/pane/t1/", "/index.html", "/index%2ehtml"]) {
    assertEquals(shellFile(path, false), { rel: "index.html", page: true }, path);
  }
  for (
    const [path, rel] of [
      ["/app%2ejs", "app.js"],
      ["/%61pp.js", "app.js"],
      ["/sw%2ejs", "sw.js"],
    ]
  ) {
    assertEquals(shellFile(path, false), { rel, page: false }, path);
  }
  for (
    const path of [
      "/assets%2fx.svg",
      "/app%252ejs",
      "/pane%00x",
      "/a%5cb",
      "/pane//t1",
      "/%2e%2fapp.js",
      "/.env",
      "/dev/widgets",
      "/x.exe",
      "/%E0%A4%A",
    ]
  ) {
    assertEquals(shellFile(path, false), null, path);
  }
});

Deno.test("serveShell independently refuses non-page navigation", async () => {
  const root = await Deno.makeTempDir({ dir: ".tmp", prefix: "shell-file-" });
  try {
    await Deno.mkdir(`${root}/dist`);
    await Deno.writeTextFile(`${root}/dist/app.js`, "app asset");
    for (const head of [false, true]) {
      const response = await serveShell(root, { rel: "app.js", page: false }, head, "navigate");
      assertEquals(response.status, 404, `head=${head}`);
      await response.body?.cancel();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
