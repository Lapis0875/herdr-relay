// Synthetic fixture: no files from the real Herdr home or the private lstack fork.
export const sourceFiles: Record<string, string> = {
  "layouts/lstack-herdr.svg": "<svg>source</svg>\n",
  "layouts/.state/lstack-herdr.json": '{"active":"source"}\n',
  "mods/lstack-herdr/main.js": "source main\n",
  "mods/lstack-herdr/components/nested.js": "source nested\n",
  "mods/lstack-herdr/.lstack-sync.json": '{"version":1}\n',
  "mods/lstack-herdr/gpui-kit.d.ts": "excluded declaration\n",
  "mods/lstack-herdr/components/jsconfig.json": "excluded config\n",
  "mods/lstack-herdr-cockpit/main.js": "cockpit source\n",
  "mods/lstack-herdr-cockpit/nested/gpui-kit.d.ts": "excluded declaration\n",
  "mods/lstack-herdr-cockpit/jsconfig.json": "excluded config\n",
  "mods/tabs/main.js": "shipped tabs\n",
  "mods/files/main.js": "shipped files\n",
  "mods/changes/main.js": "shipped changes\n",
  "mods/workspace-chrome/main.js": "shipped chrome\n",
  "mods/lstack-herdr-other/main.js": "not an included mod\n",
  "themes/dark.json": '{"theme":"dark"}\n',
  "themes/light.json": '{"theme":"light"}\n',
  "themes/not-json.txt": "not a theme\n",
  "themes/nested/not-in-glob.json": "not a direct theme\n",
  "programs.json": '{"programs":["source"]}\n',
  "my-icons/nested/star.svg": "<svg>star</svg>\n",
  "keys.json": JSON.stringify(
    {
      "mod:lstack-herdr": { "alt-m": "source-mod" },
      "mod:lstack-herdr-cockpit": { "alt-c": "source-cockpit" },
      global: { "alt-a": "source-global" },
      "layout:lstack-herdr": { "alt-z": "source-z", "alt-a": "source-a" },
      "layout:other": { "alt-o": "source-other" },
    },
    null,
    2,
  ) + "\n",
  "settings.json": '{"font":"Source","zoom":2}\n',
  "shared.json": "source shared\n",
  "view.json": "source view\n",
  "window.json": "source window\n",
  "seen.json": "source seen\n",
  "cockpit.json": "source cockpit\n",
  "data/cache.json": "source cache\n",
};

export const targetFiles: Record<string, string> = {
  "layouts/lstack-herdr.json": '{"layout":"old"}\n',
  "mods/tabs/main.js": "target shipped tabs\n",
  "keys.json": JSON.stringify(
    {
      global: { "alt-a": "target-global" },
      "layout:lstack-herdr": { "alt-old": "old" },
      "mod:lstack-herdr": { "alt-old": "target-mod" },
      "layout:other": { "alt-o": "target-other" },
      terminal: { "ctrl-c": "target-terminal" },
    },
    null,
    2,
  ) + "\n",
  "settings.json": '{"font":"Target","zoom":1}\n',
  "shared.json": "target shared\n",
  "view.json": "target view\n",
  "window.json": "target window\n",
  "seen.json": "target seen\n",
  "cockpit.json": "target cockpit\n",
  "data/cache.json": "target cache\n",
  "unrelated.txt": "target unrelated\n",
};

export const copiedPaths = [
  "layouts/lstack-herdr.json",
  "layouts/lstack-herdr.svg",
  "mods/lstack-herdr/main.js",
  "mods/lstack-herdr/components/nested.js",
  "mods/lstack-herdr/.lstack-sync.json",
  "mods/lstack-herdr-cockpit/main.js",
];

export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const destination = `${root}/${path}`;
    await Deno.mkdir(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(destination, content);
  }
}

export async function readTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) await walk(`${directory}/${entry.name}`, path);
      else if (entry.isFile) result[path] = await Deno.readTextFile(`${directory}/${entry.name}`);
      else throw new Error(`Unexpected fixture entry: ${path}`);
    }
  }
  try {
    await walk(root, "");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return result;
}

export async function withFixture(fn: (source: string, target: string) => Promise<void>): Promise<void> {
  await Deno.mkdir(".tmp", { recursive: true });
  const root = await Deno.makeTempDir({ dir: ".tmp", prefix: "sync-config-" });
  try {
    const source = `${root}/source`;
    const target = `${root}/target`;
    await writeTree(source, await readTree("fixtures/generic-home"));
    await writeTree(source, sourceFiles);
    await writeTree(source, {
      "layouts/lstack-herdr.json": await Deno.readTextFile("fixtures/layouts/lstack-herdr.json"),
    });
    await writeTree(target, targetFiles);
    await fn(source, target);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
