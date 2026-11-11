// Refresh the offline Herdr fixture from an immutable upstream commit. A tag is accepted when
// `fixtures/contract/<ver>/` holds that version's captured `herdr.d.ts` and `gpui-kit.d.ts` (Herdr generates the
// latter; the upstream repository has none): `deno task contract:update --tag v<ver> --from <appHome>` captures them.
// Without `--tag`, the newest captured version.
const root = new URL("../../fixtures/generic-home/", import.meta.url);
const contracts = new URL("../../fixtures/contract/", import.meta.url);
const args = Deno.args;
const check = args.includes("--check");
async function exists(url: URL): Promise<boolean> {
  try {
    return (await Deno.stat(url)).isFile;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}
/** The versions with a captured contract, oldest first. */
async function capturedVersions(): Promise<string[]> {
  const versions: string[] = [];
  for await (const entry of Deno.readDir(contracts)) {
    if (!entry.isDirectory || !/^\d+\.\d+\.\d+$/.test(entry.name)) continue;
    const dir = new URL(`${entry.name}/`, contracts);
    const found = await Promise.all(["gpui-kit.d.ts", "herdr.d.ts"].map((name) => exists(new URL(name, dir))));
    if (found.every(Boolean)) versions.push(entry.name);
  }
  return versions.sort((a, b) => {
    const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
}
const captured = await capturedVersions();
const tagIndex = args.indexOf("--tag");
const tag = tagIndex < 0 ? (captured.length > 0 ? `v${captured.at(-1)}` : undefined) : args[tagIndex + 1];
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag) || !captured.includes(tag.slice(1))) {
  throw new Error(
    `${tag ?? "No tag"} has no captured contract in fixtures/contract/ (captured: ${
      captured.map((v) => `v${v}`).join(", ") || "none"
    })`,
  );
}
const contract = new URL(`${tag.slice(1)}/`, contracts);
const encoder = new TextEncoder();
const digest = async (algorithm: string, bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest(algorithm, bytes as Uint8Array<ArrayBuffer>))).map((b) =>
    b.toString(16).padStart(2, "0")
  )
    .join("");
async function files(dir: URL, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = prefix + entry.name;
    if (entry.isDirectory) result.push(...await files(new URL(entry.name + "/", dir), path + "/"));
    else if (entry.isFile) result.push(path);
    else throw new Error(`Unexpected fixture entry: ${path}`);
  }
  return result.sort();
}
async function get(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { "User-Agent": "herdr-relay-fixtures" } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}
if (check) {
  const manifest = JSON.parse(await Deno.readTextFile(new URL("MANIFEST.json", root)));
  if (manifest.tag !== tag || !/^[a-f0-9]{40}$/.test(manifest.commit)) throw new Error("Invalid manifest identity");
  const paths = (await files(root)).filter((p) => p !== "MANIFEST.json");
  if (JSON.stringify(paths) !== JSON.stringify(Object.keys(manifest.files).sort())) {
    throw new Error("Fixture file list differs from manifest");
  }
  for (const path of paths) {
    if (await digest("SHA-256", await Deno.readFile(new URL(path, root))) !== manifest.files[path]) {
      throw new Error(`Fixture hash mismatch: ${path}`);
    }
  }
  console.log(`Verified ${paths.length} fixture files at ${manifest.commit}`);
} else {
  const ref = await (await get(`https://api.github.com/repos/herdrdev/herdr-app/git/ref/tags/${tag}`)).json();
  if (ref.object.type !== "commit" || !/^[a-f0-9]{40}$/.test(ref.object.sha)) throw new Error("Expected a commit tag");
  const commit: string = ref.object.sha;
  const tree = await (await get(`https://api.github.com/repos/herdrdev/herdr-app/git/trees/${commit}?recursive=1`))
    .json();
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("Incomplete upstream tree");
  const selected = tree.tree.filter((item: { path: string; type: string }) =>
    item.type === "blob" &&
    (/^defaults\/(mods|layouts|themes|icons)\//.test(item.path) ||
      /^defaults\/frame\/.*\.(?:svg|png|jpe?g|webp|gif|ico)$/i.test(item.path) ||
      /^defaults\/(herdr\.d\.ts|keys(?:\.macos)?\.json|programs\.json)$/.test(item.path) || item.path === "LICENSE")
  );
  const entries: Array<[string, Uint8Array]> = [];
  for (const item of selected) {
    if (!item.path.startsWith("defaults/") && item.path !== "LICENSE") throw new Error(`Unsafe path: ${item.path}`);
    if (item.path.split("/").some((part: string) => !part || part === "." || part === ".." || part.includes("\\"))) {
      throw new Error(`Unsafe path: ${item.path}`);
    }
    const encodedPath = item.path.split("/").map(encodeURIComponent).join("/");
    const bytes = new Uint8Array(
      await (await get(`https://raw.githubusercontent.com/herdrdev/herdr-app/${commit}/${encodedPath}`)).arrayBuffer(),
    );
    const header = encoder.encode(`blob ${bytes.length}\0`);
    const blob = new Uint8Array(header.length + bytes.length);
    blob.set(header);
    blob.set(bytes, header.length);
    if (await digest("SHA-1", blob) !== item.sha) throw new Error(`Upstream blob mismatch: ${item.path}`);
    entries.push([item.path === "LICENSE" ? "LICENSE" : item.path.slice(9), bytes]);
  }
  const mods = new Set(entries.map(([path]) => /^mods\/([^/]+)\//.exec(path)?.[1]).filter((x): x is string => !!x));
  const expected =
    "agents changes confirm files help machine-add menu new-menu pane peek picker prompt spaces tabs terminals-bar terminals-pane toast win98 workspace-chrome workspace-status worktree"
      .split(" ");
  if (JSON.stringify([...mods].sort()) !== JSON.stringify(expected.sort())) throw new Error("Unexpected shipped mods");
  const dts = await Deno.readFile(new URL("gpui-kit.d.ts", contract));
  const herdr = await Deno.readFile(new URL("herdr.d.ts", contract));
  const upstreamHerdr = entries.find(([path]) => path === "herdr.d.ts")?.[1];
  if (!upstreamHerdr || await digest("SHA-256", upstreamHerdr) !== await digest("SHA-256", herdr)) {
    throw new Error("herdr.d.ts differs from captured contract");
  }
  entries.push(["gpui-kit.d.ts", dts]);
  for (const mod of mods) entries.push([`mods/${mod}/gpui-kit.d.ts`, dts]);
  for (const name of ["main", "terminals", "win98"]) {
    if (!entries.some(([p]) => p === `layouts/${name}.json`)) throw new Error(`Missing ${name} layout`);
    entries.push([`layouts/.state/${name}.json`, encoder.encode('{"nodes":{}}\n')]);
  }
  entries.push(["settings.json", encoder.encode("{}\n")]);
  entries.push([
    "NOTICE.md",
    encoder.encode(
      `# Fixture attribution\n\nHerdr shipped mods, layouts and defaults are © Herdr contributors, Apache-2.0, unmodified copies from herdrdev/herdr-app ${tag}. gpui-kit.d.ts is generated by gpui-kit, Apache-2.0. Herdr icons: Lucide ISC, Feather MIT and LobeHub MIT (see upstream defaults/icons/LICENSES.md). Synthetic state and settings are fixture data.\n`,
    ),
  ]);
  await Deno.mkdir(root, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const [path, bytes] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const url = new URL(path, root);
    await Deno.mkdir(new URL("./", url), { recursive: true });
    await Deno.writeFile(url, bytes);
    hashes[path] = await digest("SHA-256", bytes);
  }
  await Deno.writeTextFile(
    new URL("MANIFEST.json", root),
    JSON.stringify({ tag, commit, files: hashes }, null, 2) + "\n",
  );
  console.log(`Assembled ${entries.length} fixture files at ${commit}`);
}
